import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { html } from 'hono/html';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { nanoid } from 'nanoid';

const app = new Hono();

// --- CORS Configuration ---
app.use(
	'/api/*',
	cors({
		origin: ['https://alumglass.com', 'http://localhost:*', 'http://127.0.0.1:*'], // Add your production domain
		allowMethods: ['POST', 'GET', 'OPTIONS'],
		allowHeaders: ['Content-Type', 'Authorization'],
		exposeHeaders: ['Content-Length'],
		maxAge: 600,
		credentials: true,
	})
);
app.use('/widget', cors({ origin: '*' })); // Allow embedding
// --- Constants ---
const ANON_SESSION_COOKIE_NAME = 'alumglass_anon_session';
const CHAT_HISTORY_LIMIT = 8; // Number of messages (user + bot) to fetch for context
app.use('/api/*', async (c, next) => {
	let sessionId = getCookie(c, ANON_SESSION_COOKIE_NAME);
	if (!sessionId) {
		sessionId = nanoid(16); // Generate a simple random ID
		console.log('Worker: No session cookie found, generating new ID:', sessionId);
		setCookie(c, ANON_SESSION_COOKIE_NAME, sessionId, {
			path: '/',
			secure: true, // Send only over HTTPS
			httpOnly: true, // Prevent client-side JS access
			maxAge: 60 * 60 * 24 * 30, // ~30 days validity
			sameSite: 'Lax', // Adjust as needed ('None' if cross-site POST required, but needs Secure)
		});
	} else {
		// console.log("Worker: Found session cookie:", sessionId); // Can log if needed
	}
	c.set('sessionId', sessionId); // Make session ID available to API handlers
	await next();
});

// --- D1 Helper Functions ---

async function getChatHistory(db, sessionId, limit) {
	if (!sessionId) return [];
	try {
		console.log(`Worker: Fetching last ${limit} messages for session: ${sessionId}`);
		const stmt = db
			.prepare(
				`SELECT role, content FROM chat_history
       WHERE session_id = ?
       ORDER BY timestamp DESC
       LIMIT ?`
			)
			.bind(sessionId, limit);
		const { results } = await stmt.all();
		// Reverse results to get chronological order for the prompt
		return results ? results.reverse() : [];
	} catch (error) {
		console.error(`Worker: Error fetching chat history for session ${sessionId}:`, error);
		return [];
	}
}
// Function to get ALL history for a session
async function getAllChatHistory(db, sessionId) {
	if (!sessionId) return [];
	try {
		console.log(`Worker: Fetching ALL messages for session: ${sessionId}`);
		const stmt = db
			.prepare(
				`SELECT message_id, role, content, timestamp FROM chat_history
       WHERE session_id = ?
       ORDER BY timestamp ASC` // Get in chronological order for display
			)
			.bind(sessionId);
		const { results } = await stmt.all();
		return results || [];
	} catch (error) {
		console.error(`Worker: Error fetching ALL chat history for session ${sessionId}:`, error);
		return []; // Return empty array or throw error? Empty array is safer for client.
	}
}

async function saveChatMessage(db, sessionId, role, content, userName = null, userContact = null) {
	if (!sessionId || !role || !content) return false;
	try {
		// Only include user_name and user_contact for 'user' roles and if provided
		if (role === 'user' && (userName || userContact)) {
			const stmt = db
				.prepare(
					`INSERT INTO chat_history (session_id, role, content, user_name_provided, user_contact_provided)
                 VALUES (?, ?, ?, ?, ?)`
				)
				.bind(sessionId, role, content, userName, userContact);
			await stmt.run();
		} else {
			// For bot messages or user messages without extra info
			const stmt = db
				.prepare(
					`INSERT INTO chat_history (session_id, role, content)
                 VALUES (?, ?, ?)`
				)
				.bind(sessionId, role, content);
			await stmt.run();
		}
		return true;
	} catch (error) {
		console.error(`Worker: Error saving chat message for session ${sessionId}:`, error);
		return false;
	}
}

async function getLatestProvidedUserInfo(db, sessionId) {
	if (!sessionId) return null;
	try {
		console.log(`Worker: Fetching latest provided user info for session: ${sessionId}`);
		// Query for the most recent user message that has either user_name_provided or user_contact_provided
		const stmt = db
			.prepare(
				`SELECT user_name_provided, user_contact_provided
             FROM chat_history
             WHERE session_id = ? AND role = 'user' AND (user_name_provided IS NOT NULL OR user_contact_provided IS NOT NULL)
             ORDER BY timestamp DESC
             LIMIT 1`
			)
			.bind(sessionId);

		const result = await stmt.first(); // Get only the most recent one

		if (result) {
			return {
				name: result.user_name_provided,
				contact: result.user_contact_provided,
			};
		}
		return null; // No info found for this session
	} catch (error) {
		console.error(`Worker: Error fetching latest provided user info for session ${sessionId}:`, error);
		return null;
	}
}

const GEMINI_CHAT_KEY_ORDER = ['GEMINI_API_KEY_FREE', 'GEMINI_API_KEY_PAID1', 'GEMINI_API_KEY_128K', 'GEMINI_API_KEY_PAID2'];
const GEMINI_EMBEDDING_KEY_VAR = 'GEMINI_API_KEY_EMBEDDING'; // Separate key for embedding
const MAX_TOTAL_ATTEMPTS = 5; // Max tries across *all* keys for a single request
const RETRY_DELAY_MS = 300; // Small delay before retrying with next key

// --- NEW: Centralized Gemini Fetch Function with Retry/Fallback ---
async function fetchGeminiWithRetry(endpointUrl, requestBody, keyEnvVarNames, isEmbeddingCall, env) {
	let currentKeyIndex = 0;
	let attempts = 0;
	const keysToTry = isEmbeddingCall ? [GEMINI_EMBEDDING_KEY_VAR] : keyEnvVarNames;

	console.log(`Worker: Starting Gemini call. Embedding: ${!!isEmbeddingCall}. Keys to try: ${keysToTry.join(', ')}`);

	while (attempts < MAX_TOTAL_ATTEMPTS && currentKeyIndex < keysToTry.length) {
		attempts++;
		const currentKeyVarName = keysToTry[currentKeyIndex];
		const apiKey = env[currentKeyVarName];

		if (!apiKey) {
			console.warn(`Worker: API Key variable '${currentKeyVarName}' not found in environment. Skipping.`);
			currentKeyIndex++; // Move to the next key
			continue; // Try next key
		}

		const apiUrlWithKey = `${endpointUrl}?key=${apiKey}`;
		console.log(`Worker: Attempt #${attempts} using key var '${currentKeyVarName}'. URL: ${endpointUrl}`); // Don't log full URL with key

		try {
			const response = await fetch(apiUrlWithKey, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(requestBody),
			});

			if (response.ok) {
				const data = await response.json();
				console.log(`Worker: Gemini call successful with key var '${currentKeyVarName}' (Attempt #${attempts}).`);
				return { success: true, data: data }; // Successful response
			}

			// --- Handle Errors ---
			const status = response.status;
			let errorText = await response.text();
			let errorJson = {};
			let errorMessage = `HTTP ${status}: ${errorText}`;
			try {
				errorJson = JSON.parse(errorText);
				errorMessage = errorJson.error?.message || errorMessage;
			} catch {}

			console.warn(
				`Worker: Gemini call failed with key var '${currentKeyVarName}' (Attempt #${attempts}). Status: ${status}, Message: ${errorMessage}`
			);

			// Check for Quota Error (429 or specific messages)
			const isQuotaError = status === 429 || /quota|rate limit|resource exhausted/i.test(errorMessage);

			if (isQuotaError) {
				console.warn(`Worker: Quota/Rate limit hit for key var '${currentKeyVarName}'. Trying next key.`);
				currentKeyIndex++; // Move to the next key
				if (currentKeyIndex < keysToTry.length) {
					await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS)); // Wait briefly before next try
				}
				continue; // Go to the next iteration of the while loop
			} else {
				// For other errors (400, 500, etc.), fail immediately for this request
				console.error(`Worker: Unrecoverable Gemini error with key var '${currentKeyVarName}'. Failing request.`);
				return { success: false, error: { status: status, message: errorMessage } };
			}
		} catch (fetchError) {
			console.error(
				`Worker: Network/Fetch error during Gemini call with key var '${currentKeyVarName}' (Attempt #${attempts}):`,
				fetchError
			);
			// Treat network errors like unrecoverable errors for this attempt, but maybe retry next key?
			// For simplicity now, we'll fail the request on fetch errors. Could increment key index here too.
			return { success: false, error: { status: 500, message: `Network error during API call: ${fetchError.message}` } };
		}
	} // End while loop

	// If loop finishes without success
	console.error(`Worker: Gemini call failed after ${attempts} attempts and trying ${currentKeyIndex} keys.`);
	if (currentKeyIndex >= keysToTry.length) {
		return { success: false, error: { status: 429, message: 'All API keys hit quota limits or were invalid.' } };
	} else {
		return { success: false, error: { status: 500, message: `Failed after ${MAX_TOTAL_ATTEMPTS} total attempts.` } };
	}
}
// --- Widget HTML/CSS/JS ---
const renderWidget = () => {
	// Add base URL dynamically for constructing share links later
	//const widgetBaseUrl = 'https://bhrwidget.aihoore.ir';
	// Combined HTML for Chat and Vector Search within the widget
	return html`
		<!DOCTYPE html>
		<html lang="fa" dir="rtl">
			<head>
				<meta charset="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>AlumGlass AI مشاور</title>
				<script src="https://cdn.tailwindcss.com"></script>
				<script src="https://cdn.jsdelivr.net/npm/markdown-it@14.1.0/dist/markdown-it.min.js"></script>
				<link rel="preconnect" href="https://fonts.googleapis.com" />
				<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
				<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@100..900&display=swap" rel="stylesheet" />
				<link
					href="https://fonts.googleapis.com/css2?family=Lateef:wght@200;300;400;500;600;700;800&family=Vazirmatn:wght@100..900&display=swap"
					rel="stylesheet"
				/>
				<link
					rel="stylesheet"
					href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css"
					integrity="sha512-DTOQO9RWCH3ppGqcWaEA1BIZOC6xxalwEsw9c2QQeAIftl+Vegovlnee1c9QX4TctnWMn13TZye+giMm8e2LwA=="
					crossorigin="anonymous"
					referrerpolicy="no-referrer"
				/>
				<!-- فونت‌های فارسی بهتر -->
				<link href="https://cdnjs.cloudflare.com/ajax/libs/vazirmatn/33.0.3/Vazirmatn-font-face.min.css" rel="stylesheet" />
				<link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet" />

				<style>
					html,
					body {
						margin: 0;
						padding: 0;
						height: 100%;
						overflow: hidden;
						background-color: #121212;
					}

					.alumglass-widget {
						font-family: 'Vazirmatn', sans-serif;
						font-weight: 400;
						color: #e0e0e0;
						width: 100%;
						height: 100%;
						box-sizing: border-box;
						overflow: hidden;
						display: flex;
						flex-direction: column;
						background-color: #121212;
						padding: 0.5rem;
						gap: 0.5rem;
					}

					/* Improved Tab Buttons */
					#tab-buttons {
						display: flex;
						background-color: #1e1e1e;
						border-radius: 8px;
						overflow: hidden;
						max-width: 500px;
						margin: 0 auto;
						box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
						flex-shrink: 0;
					}

					.tab-button {
						flex-grow: 1;
						padding: 0.6rem 1rem;
						cursor: pointer;
						background-color: #1e1e1e;
						border: none;
						color: #aaa;
						font-size: 0.9rem;
						font-family: 'Vazirmatn', sans-serif;
						transition: all 0.3s ease;
					}

					.tab-button:hover {
						background-color: #2a2a2a;
						color: #fff;
					}

					.tab-button.active {
						background-color: #3b82f6;
						color: #ffffff;
						font-weight: 600;
					}

					/* Tab Content Area */
					#tab-content {
						flex-grow: 1;
						overflow: hidden;
						position: relative;
						border-radius: 8px;
						background-color: #1a1a1a;
						box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
					}

					.tab-pane {
						width: 100%;
						height: 100%;
						box-sizing: border-box;
						padding: 0.75rem;
						display: flex;
						flex-direction: column;
						overflow: hidden;
					}

					.tab-pane:not(.active) {
						display: none;
					}

					/* Section Styles */
					.tab-pane h2 {
						font-size: 1rem;
						font-weight: 600;
						margin-bottom: 0.5rem;
						padding-bottom: 0.3rem;
						border-bottom: 1px solid #333;
						color: #3b82f6;
						text-align: right;
						flex-shrink: 0;
					}

					/* Chat Styles */
					#chat-messages {
						font-family: 'Lateef', serif;
						flex-grow: 1;
						overflow-y: auto;
						margin-bottom: 0.75rem;
						padding: 0 0.5rem;
						scrollbar-width: thin;
						scrollbar-color: #444 #1e1e1e;
						border-radius: 6px;
						background-color: #1d1d1d;
					}

					#chat-messages::-webkit-scrollbar {
						width: 5px;
					}

					#chat-messages::-webkit-scrollbar-track {
						background: #1e1e1e;
						border-radius: 4px;
					}

					#chat-messages::-webkit-scrollbar-thumb {
						background-color: #444;
						border-radius: 4px;
					}

					.message-base {
						padding: 0.6rem 0.8rem;
						border-radius: 0.8rem;
						margin-bottom: 0.75rem;
						max-width: 80%;
						word-wrap: break-word;
						font-size: 1.1em;
						line-height: 1.6;
						box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
					}

					.user-message {
						margin-left: auto;
						text-align: right;
						background-color: #2d4263;
						color: #ffffff;
						border-bottom-right-radius: 0.3rem;
					}

					.bot-message {
						margin-right: auto;
						text-align: right;
						background-color: #2d2d2d;
						color: #ffffff;
						border-bottom-left-radius: 0.3rem;
					}

					.bot-message strong {
						color: #a5d6ff;
					}

					.bot-message a {
						color: #7dd3fc;
						text-decoration: underline;
					}

					.bot-message a:hover {
						color: #a5d6ff;
					}

					.astra-results-container {
						margin-top: 0.75rem;
						padding-top: 0.5rem;
						border-top: 1px dashed #444;
						font-size: 0.85em;
						opacity: 0.9;
					}

					.astra-results-container strong {
						color: #facc15;
					}

					.astra-doc {
						margin-bottom: 0.5rem;
					}

					.error-message {
						text-align: right;
						background-color: #7f1d1d;
						color: #fecaca;
						border: 1px solid #924040;
						padding: 0.5rem 0.75rem;
						border-radius: 0.5rem;
						margin-top: 0.5rem;
						font-size: 0.85em;
					}

					/* Input Areas */
					.input-area {
						display: flex;
						gap: 0.5rem;
						align-items: center;
						margin-top: auto;
						flex-shrink: 0;
						background-color: #1d1d1d;
						padding: 0.5rem;
						border-radius: 8px;
						box-shadow: 0 -1px 5px rgba(0, 0, 0, 0.1);
					}

					.input-area input[type='text'] {
						flex-grow: 1;
						background-color: #2d2d2d;
						color: #e0e0e0;
						border: 1px solid #444;
						padding: 0.6rem 0.8rem;
						border-radius: 0.5rem;
						font-family: 'Vazirmatn', sans-serif;
						transition: all 0.2s ease;
					}

					.input-area input[type='text']:focus {
						outline: none;
						border-color: #3b82f6;
						box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.3);
					}

					.input-area button {
						background-color: #3b82f6;
						color: white;
						padding: 0.6rem 0.8rem;
						border: none;
						border-radius: 0.5rem;
						cursor: pointer;
						transition: all 0.2s ease;
						font-family: 'Vazirmatn', sans-serif;
						flex-shrink: 0;
						font-weight: 500;
					}

					.input-area button:hover:not(:disabled) {
						background-color: #2563eb;
						transform: translateY(-1px);
					}

					.input-area button:disabled {
						background-color: #555;
						cursor: not-allowed;
						opacity: 0.7;
					}

					/* Search Section Specifics */
					.search-section {
						flex-shrink: 0;
					}

					#results {
						flex-grow: 1;
						overflow-y: auto;
						margin-top: 0.75rem;
						scrollbar-width: thin;
						scrollbar-color: #444 #1e1e1e;
						padding: 0 0.5rem;
						border-radius: 6px;
						background-color: #1d1d1d;
					}

					#results::-webkit-scrollbar {
						width: 5px;
					}

					#results::-webkit-scrollbar-track {
						background: #1e1e1e;
					}

					#results::-webkit-scrollbar-thumb {
						background-color: #444;
						border-radius: 4px;
					}

					.result-card {
						background-color: #242424;
						color: #e0e0e0;
						border: 1px solid #333;
						padding: 0.75rem;
						border-radius: 0.5rem;
						margin-bottom: 0.75rem;
						font-size: 0.9em;
						direction: rtl;
						transition: transform 0.2s ease, box-shadow 0.2s ease;
					}

					.result-card:hover {
						transform: translateY(-2px);
						box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
					}

					.result-card h3 {
						font-weight: 600;
						color: #a5d6ff;
						margin-bottom: 0.25rem;
						text-align: right;
					}

					.result-card p {
						margin-bottom: 0.25rem;
						text-align: right;
					}

					.result-card .similarity {
						font-size: 0.8em;
						color: #9ca3af;
						text-align: left;
						direction: ltr;
					}

					.result-card .metadata-grid {
						display: grid;
						grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
						gap: 0.5rem;
						font-size: 0.85em;
						margin-top: 0.5rem;
					}

					.result-card .metadata-grid p {
						margin-bottom: 0;
						text-align: right;
					}

					.result-card .metadata-grid strong {
						color: #ccc;
					}

					.loading-indicator {
						text-align: center;
						margin-top: 0.5rem;
						font-size: 0.9em;
						color: #9ca3af;
						height: 24px;
						flex-shrink: 0;
					}

					.loading-indicator.hidden {
						display: none;
					}

					.loading {
						display: inline-block;
						width: 1em;
						height: 1em;
						vertical-align: -0.125em;
						animation: spin 1s linear infinite;
						color: #3b82f6;
					}

					@keyframes spin {
						from {
							transform: rotate(0deg);
						}
						to {
							transform: rotate(360deg);
						}
					}

					/* General Error Div */
					.general-error {
						display: none;
						flex-shrink: 0;
					}

					.astra-results-details {
						margin-top: 0.75rem;
						padding-top: 0.5rem;
						border-top: 1px dashed #444;
						background-color: rgba(255, 255, 255, 0.03);
						border-radius: 6px;
						padding: 0.5rem;
					}

					.astra-results-summary {
						cursor: pointer;
						font-weight: 600;
						color: #facc15;
						padding: 0.5rem 0.25rem;
						outline: none;
						transition: background-color 0.2s;
						border-radius: 3px;
						display: block;
					}

					.astra-results-summary:hover {
						background-color: rgba(255, 255, 255, 0.07);
					}

					.astra-results-summary::marker {
						color: #facc15;
					}

					.astra-results-summary::-webkit-details-marker {
						color: #facc15;
					}

					.astra-results-list {
						padding-top: 0.75rem;
						padding-right: 1.5rem;
						font-size: 0.9em;
						opacity: 0.9;
					}

					.astra-doc {
						margin-bottom: 0.75rem;
						padding-bottom: 0.5rem;
						border-bottom: 1px solid #333;
					}

					.astra-doc:last-child {
						border-bottom: none;
						margin-bottom: 0;
					}

					.explanation-text {
						font-size: 0.85em;
						color: #a0a0a0;
						text-align: right;
						margin: 5px 0 10px 0;
						line-height: 1.5;
						padding: 0 0.5rem;
						background-color: rgba(59, 130, 246, 0.05);
						border-radius: 6px;
						padding: 0.5rem;
					}

					.credits-text {
						font-size: 0.8em;
						color: #777;
						text-align: center;
						margin-top: auto;
						padding-top: 8px;
						flex-shrink: 0;
					}

					#user-info-form {
						padding: 1rem;
						flex-shrink: 0;
						background-color: #1d1d1d;
						border-radius: 8px;
						margin-bottom: 0.5rem;
					}

					#user-info-form .form-grid {
						display: grid;
						grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
						gap: 0.75rem;
						margin-bottom: 1rem;
					}

					#user-info-form label {
						display: block;
						font-size: 0.9em;
						margin-bottom: 0.25rem;
						color: #ccc;
					}

					#user-info-form input[type='text'],
					#user-info-form input[type='tel'],
					#user-info-form input[type='email'] {
						width: 100%;
						background-color: #2d2d2d;
						color: #e0e0e0;
						border: 1px solid #444;
						padding: 0.5rem 0.8rem;
						border-radius: 0.5rem;
						font-size: 0.95em;
						box-sizing: border-box;
						transition: all 0.2s ease;
					}

					#user-info-form input:focus {
						outline: none;
						border-color: #3b82f6;
						box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.3);
					}

					#user-info-form button {
						width: 100%;
						background-color: #16a34a;
						color: white;
						padding: 0.6rem 1rem;
						border: none;
						border-radius: 0.5rem;
						cursor: pointer;
						transition: all 0.2s ease;
						font-family: 'Vazirmatn', sans-serif;
						font-weight: 600;
						margin-top: 0.5rem;
					}

					#user-info-form button:hover {
						background-color: #15803d;
						transform: translateY(-1px);
					}

					#user-info-note {
						font-size: 0.8em;
						color: #888;
						text-align: right;
						margin-bottom: 1rem;
					}

					/* Remember Me Checkbox */
					.remember-me-container {
						display: flex;
						align-items: center;
						gap: 0.5rem;
						margin-bottom: 1rem;
						cursor: pointer;
					}

					.remember-me-container input[type='checkbox'] {
						cursor: pointer;
						accent-color: #3b82f6;
						width: 16px;
						height: 16px;
					}

					.remember-me-container label {
						font-size: 0.9em;
						color: #bbb;
						margin-bottom: 0;
						user-select: none;
					}

					#chat-input-area.hidden,
					#user-info-form.hidden {
						display: none;
					}

					/* Welcome Message */
					#welcome-back-message {
						font-size: 0.9em;
						color: #a0a0a0;
						text-align: right;
						padding: 0.5rem 0.75rem;
						margin-bottom: 0.5rem;
						border-bottom: 1px solid #333;
						display: none;
						flex-shrink: 0;
						background-color: rgba(59, 130, 246, 0.1);
						border-radius: 6px;
					}

					#chat-actions-container {
						position: absolute;
						top: 10px;
						left: 15px;
						z-index: 10;
						display: flex;
						gap: 8px;
						direction: ltr;
					}

					#chat-actions-container button {
						background-color: rgba(85, 85, 85, 0.8);
						color: #eee;
						border: none;
						border-radius: 4px;
						padding: 4px 8px;
						cursor: pointer;
						font-size: 0.8em;
						line-height: 1;
						transition: all 0.2s ease;
						display: flex;
						align-items: center;
						gap: 4px;
						backdrop-filter: blur(2px);
					}

					#chat-actions-container button:hover:not(:disabled) {
						background-color: rgba(102, 102, 102, 0.9);
						transform: translateY(-1px);
					}

					#chat-actions-container button:disabled {
						opacity: 0.5;
						cursor: not-allowed;
					}

					#chat-actions-container.hidden {
						display: none;
					}

					#chat-actions-container button i {
						margin-right: 0;
					}

					.message-action-button {
						background-color: rgba(85, 85, 85, 0.7);
						color: #eee;
						border: none;
						border-radius: 4px;
						padding: 3px 6px;
						cursor: pointer;
						font-size: 0.75em;
						line-height: 1;
						transition: all 0.2s ease;
					}

					.message-action-button:hover {
						background-color: rgba(102, 102, 102, 0.8);
						transform: translateY(-1px);
					}

					.message-action-button i {
						margin-right: 3px;
					}

					/* Light Theme Switch - Optional for future use */
					.theme-switch {
						position: absolute;
						top: 10px;
						right: 15px;
						z-index: 10;
						background-color: rgba(85, 85, 85, 0.5);
						border-radius: 20px;
						padding: 3px;
						transition: all 0.2s ease;
						backdrop-filter: blur(2px);
						display: flex;
						align-items: center;
						cursor: pointer;
					}

					.theme-switch:hover {
						background-color: rgba(102, 102, 102, 0.7);
					}

					.theme-switch-icon {
						width: 16px;
						height: 16px;
						color: #eee;
					}
				</style>
			</head>
			<body>
				<div class="alumglass-widget">
					<!-- Tab Buttons -->
					<div id="tab-buttons">
						<button id="chat-tab-button" class="tab-button active"><i class="fas fa-comments"></i> گفتگو</button>
						<button id="search-tab-button" class="tab-button"><i class="fas fa-search"></i> جستجوی برداری</button>
					</div>

					<!-- Tab Content Area -->
					<div id="tab-content">
						<!-- Chat Tab Pane (Initially Active) -->
						<div id="chat-tab-content" class="tab-pane active">
							<h2>گفتگو با هوش مصنوعی</h2>
							<div id="welcome-back-message" style="display: none;"></div>
							<!-- Welcome message -->
							<div id="chat-actions-container" class="hidden">
								<!-- Actions -->
								<button id="copy-last-button" disabled><i class="fas fa-copy"></i> کپی آخرین پاسخ</button>
								<button id="share-chat-button" disabled><i class="fas fa-share-alt"></i> اشتراک گفتگو</button>
							</div>
							<p class="explanation-text">
								این دستیار از هوش مصنوعی پیشرفته به همراه جستجو در پایگاه داده تخصصی مباحث مقررات ملی ساختمان (روش RAG) برای ارائه پاسخ‌های
								دقیق استفاده می‌کند. تاریخچه گفتگو برای بهبود زمینه پاسخ‌ها ذخیره می‌شود.
							</p>
							<div id="chat-messages" class="chat-messages">
								<!-- Initial message(s) might change based on login state -->
							</div>
							<div id="chat-loading" class="loading-indicator hidden">
								<svg class="loading" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
									<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
									<path
										class="opacity-75"
										fill="currentColor"
										d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
									></path>
								</svg>
								<span class="ml-2">در حال پردازش چت...</span>
							</div>
							<div id="chat-error" class="error-message general-error"></div>

							<form id="user-info-form">
								<p id="user-info-note"><i class="fas fa-user-circle"></i> برای تجربه بهتر، می‌توانید اطلاعات زیر را وارد کنید (اختیاری).</p>
								<div class="form-grid">
									<div>
										<label for="user-name"><i class="fas fa-user"></i> نام و نام خانوادگی</label>
										<input type="text" id="user-name" name="name" placeholder="نام شما..." />
									</div>
									<div>
										<label for="user-contact"><i class="fas fa-envelope"></i> ایمیل یا تلفن</label>
										<input type="text" id="user-contact" name="contact" placeholder="راه ارتباطی..." />
									</div>
								</div>

								<div class="remember-me-container">
									<input type="checkbox" id="remember-me" name="rememberMe" />
									<label for="remember-me"><i class="fas fa-save"></i> مرا در این دستگاه به خاطر بسپار</label>
								</div>
								<!-- End Remember Me -->
								<button type="submit" id="start-chat-button"><i class="fas fa-paper-plane"></i> شروع گفتگو</button>
							</form>
							<!-- End User Info Form -->
							<!-- Chat Input Area (Initially Hidden) -->
							<div id="chat-input-area" class="input-area hidden">
								<input id="chat-input" type="text" placeholder="سوال خود را برای چت بنویسید..." />
								<button id="chat-send-button"><i class="fas fa-paper-plane"></i> ارسال</button>
							</div>
							<!-- End Chat Input Area -->
							<p class="credits-text">تهیه شده توسط تیم تحقیق و توسعه آلوم‌گلس <i class="fas fa-heart" style="color:#e25555;"></i></p>
						</div>

						<!-- Search Tab Pane (Initially Hidden) -->
						<div id="search-tab-content" class="tab-pane">
							<h2><i class="fas fa-search"></i> جستجوی برداری</h2>
							<p class="explanation-text"><i class="fas fa-info-circle"></i> مستقیماً در میان متون فنی و تخصصی پایگاه داده جستجو کنید.</p>
							<div class="input-area">
								<input id="searchInput" type="text" placeholder="عبارت جستجو برداری..." />
								<button id="searchButton"><i class="fas fa-search"></i> جستجو</button>
							</div>
							<div id="search-loading" class="loading-indicator hidden">
								<svg class="loading" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
									<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
									<path
										class="opacity-75"
										fill="currentColor"
										d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
									></path>
								</svg>
								<span class="ml-2">در حال جستجو...</span>
							</div>
							<div id="search-error" class="error-message general-error"></div>
							<!-- Dedicated error div -->
							<div id="results"></div>
							<!-- Search results appear here -->
							<p class="credits-text">تهیه شده توسط تیم تحقیق و توسعه آلوم‌گلس <i class="fas fa-heart" style="color:#e25555;"></i></p>
						</div>
					</div>
				</div>

				<script>
					const md = new markdownit({ breaks: true, linkify: true, typographer: true });
					// --- DOM References ---
					const chatTabButton = document.getElementById('chat-tab-button');
					const searchTabButton = document.getElementById('search-tab-button');
					const chatTabContent = document.getElementById('chat-tab-content');
					const searchTabContent = document.getElementById('search-tab-content');
					const userInfoForm = document.getElementById('user-info-form');
					const startChatButton = document.getElementById('start-chat-button');
					const userNameInput = document.getElementById('user-name');
					const userContactInput = document.getElementById('user-contact');
					const rememberMeCheckbox = document.getElementById('remember-me');
					const welcomeBackMessage = document.getElementById('welcome-back-message');
					const chatInputArea = document.getElementById('chat-input-area');
					const chatInput = document.getElementById('chat-input');
					const chatSendButton = document.getElementById('chat-send-button');
					const chatMessagesDiv = document.getElementById('chat-messages');
					const chatErrorDiv = document.getElementById('chat-error');
					const chatLoadingDiv = document.getElementById('chat-loading');
					const searchInput = document.getElementById('searchInput');
					const searchButton = document.getElementById('searchButton');
					const searchErrorDiv = document.getElementById('search-error');
					const searchLoadingDiv = document.getElementById('search-loading');
					const resultsDiv = document.getElementById('results');
					const chatActionsContainer = document.getElementById('chat-actions-container');
					const copyLastButton = document.getElementById('copy-last-button');
					const shareChatButton = document.getElementById('share-chat-button');

					let chatProcessing = false;
					let searchProcessing = false;
					let rememberedUserInfo = null; // Store info retrieved from localStorage
					let lastBotMessageRawText = '';
					let currentSessionId = null; // Will be populated from API response
					// --- LocalStorage Keys ---
					const LS_REMEMBER_FLAG = 'alumglass_remember_me';
					const LS_USER_NAME = 'alumglass_user_name';
					const LS_USER_CONTACT = 'alumglass_user_contact';

					// --- Utility Functions ---
					function showLoading(indicatorType, show) {
						// Renamed parameter
						const loader = indicatorType === 'chat' ? chatLoadingDiv : searchLoadingDiv;
						loader.classList.toggle('hidden', !show);
					}

					function showError(errorDivType, message) {
						// Renamed parameter
						const errorContainer = errorDivType === 'chat' ? chatErrorDiv : searchErrorDiv;
						if (message) {
							errorContainer.textContent = 'خطا: ' + message;
							errorContainer.style.display = 'block'; // Show the error div
							setTimeout(() => {
								errorContainer.style.display = 'none';
							}, 6000);
						} else {
							errorContainer.style.display = 'none'; // Hide the error div
						}
					}

					function disableInput(inputType, disable) {
						// Renamed parameter
						if (inputType === 'chat') {
							chatInput.disabled = disable;
							chatSendButton.disabled = disable;
						} else {
							searchInput.disabled = disable;
							searchButton.disabled = disable;
						}
					}

					// --- Message Handling Functions ---
					function addChatMessage(sender, message, rawText = '') {
						const messageDiv = document.createElement('div');
						messageDiv.classList.add('message-base');

						if (sender === 'user') {
							messageDiv.classList.add('user-message');
							messageDiv.textContent = message;
						} else if (sender === 'bot') {
							messageDiv.classList.add('bot-message');
							messageDiv.innerHTML = message; // Rendered HTML
							// --- MODIFICATION: Don't add actions here anymore ---
							// addMessageActions(messageDiv, rawText);
						}
						// Store raw text on the element itself if needed for other purposes,
						// but we primarily use the global var now for top-level actions
						messageDiv.dataset.rawText = rawText;

						chatMessagesDiv.appendChild(messageDiv);
						chatMessagesDiv.scrollTo({ top: chatMessagesDiv.scrollHeight, behavior: 'smooth' });
					}

					// --- Copy Handler ---
					async function handleCopyLast(buttonElement) {
						if (!lastBotMessageRawText) return; // Nothing to copy
						if (!navigator.clipboard) {
							showError('chat', 'مرورگر شما از کپی در کلیپ‌بورد پشتیبانی نمی‌کند.');
							return;
						}
						try {
							await navigator.clipboard.writeText(lastBotMessageRawText);
							buttonElement.innerHTML = '<i class="fas fa-check"></i> کپی شد!';
							buttonElement.disabled = true;
							setTimeout(() => {
								buttonElement.innerHTML = '<i class="fas fa-copy"></i> کپی آخرین پاسخ';
								buttonElement.disabled = false;
							}, 2000);
						} catch (err) {
							//console.error('Widget: Failed to copy text:', err);
							showError('chat', 'خطا در کپی متن.');
							buttonElement.innerHTML = '<i class="fas fa-times"></i> خطا';
							setTimeout(() => {
								buttonElement.innerHTML = '<i class="fas fa-copy"></i> کپی';
							}, 2000);
						}
					}

					// ---Share Handler ---
					async function handleShareChat() {
						if (!currentSessionId) {
							showError('chat', 'شناسه گفتگو برای اشتراک‌گذاری یافت نشد.');
							return;
						}
						if (!navigator.share) {
							showError('chat', 'مرورگر شما از قابلیت اشتراک‌گذاری پشتیبانی نمی‌کند.');
							return;
						}

						// --- CONSTRUCT THE SHARE URL ---
						// Option 1: Link to a dedicated history page on your main site
						const shareUrl = \`https://alumglass.com/chat-view?session=\${currentSessionId}\`;
						// Option 2: Link directly to a potential history API endpoint (less user-friendly)
						// const shareUrl = \`\${widgetBaseUrl}/api/get-history/\${currentSessionId}\`;

						const shareData = {
							title: 'گفتگو با مشاور AlumGlass',
							text: \`خلاصه گفتگو با مشاور AlumGlass. آخرین پاسخ: \${lastBotMessageRawText.substring(0, 100)}...\`, // Share snippet
							url: shareUrl, // Share the link to the full history
						};

						try {
							await navigator.share(shareData);
							//console.log('Widget: Conversation link shared successfully');
						} catch (err) {
							if (err.name !== 'AbortError') {
								//console.error('Widget: Error sharing content:', err);
								showError('chat', 'خطا در اشتراک‌گذاری گفتگو.');
							}
						}
					}

					function formatBotResponse(botResponse, astraResults) {
						const container = document.createElement('div');
						const formattedBotResponse = document.createElement('div');
						formattedBotResponse.innerHTML = md.render(botResponse);
						container.appendChild(formattedBotResponse);

						if (astraResults && astraResults.length > 0) {
							const astraDiv = formatAstraResultsWeb(astraResults);
							container.appendChild(astraDiv);
						}
						return container.innerHTML;
					}

					function formatAstraResultsWeb(results) {
						// If no results, return an empty document fragment (won't be added to DOM)
						if (!results || results.length === 0) {
							return document.createDocumentFragment();
						}

						// Create the <details> element - this is the main container
						const detailsElement = document.createElement('details');
						detailsElement.className = 'astra-results-details'; // Add class for styling

						// Create the <summary> element - this is the clickable part
						const summaryElement = document.createElement('summary');
						summaryElement.className = 'astra-results-summary'; // Add class for styling
						summaryElement.innerHTML = \`📚 مشاهده اسناد مرتبط از پایگاه داده (\${results.length}) (کلیک کنید)\`;
						detailsElement.appendChild(summaryElement); // Add summary to details

						// Create a container for the actual list of documents INSIDE <details>
						const listContainer = document.createElement('div');
						listContainer.className = 'astra-results-list'; // Add class for styling

						// Add the documents to the list container
						results.forEach((doc, index) => {
							const docDiv = document.createElement('div');
							docDiv.className = 'astra-doc';
							// Removed the index number as it might be confusing when collapsed/expanded
							docDiv.innerHTML =
								\`<div><strong>کتاب</strong>: \${doc.metadata?.doc_name || 'نامشخص'}</div>\` +
								\`<div>   <strong>بخش</strong>: \${doc.metadata?.references || 'نامشخص'}</div>\` +
								\`<div>   <small>شباهت: \${(doc.$similarity * 100).toFixed(1)}%</small></div>\`;
							listContainer.appendChild(docDiv);
						});

						// Add the list container to the <details> element (after summary)
						detailsElement.appendChild(listContainer);

						return detailsElement; // Return the complete <details> element
					}

					function displaySearchResults(results) {
						resultsDiv.innerHTML = ''; // Clear previous results
						if (!results || results.length === 0) {
							resultsDiv.innerHTML = '<p style="text-align:center; color: #9ca3af;">نتیجه‌ای یافت نشد.</p>';
							return;
						}

						results.forEach((result) => {
							const resultCard = document.createElement('div');
							resultCard.className = 'result-card';
							resultCard.innerHTML = \`
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.5rem;">
                         <h3 style="margin-bottom: 0;">محتوا</h3>
                         <div class="similarity">شباهت: \${(result.$similarity * 100).toFixed(1)}%</div>
                    </div>
                    <p>\${
											result.content ? result.content.substring(0, 300) + (result.content.length > 300 ? '...' : '') : 'متن در دسترس نیست'
										}</p>
                    <div class="metadata-grid">
                         <div>
                             <p><strong>کتاب:</strong></p>
                             <p>\${result.metadata?.doc_name || 'N/A'}</p>
                         </div>
                         <div>
                             <p><strong>رفرنس:</strong></p>
                             <p>\${result.metadata?.references || 'N/A'}</p>
                         </div>
                    </div>
                \`;
							resultsDiv.appendChild(resultCard);
						});
					}

					// --- postMessage Communication ---
					function sendMessageToParent(messageType, text) {
						try {
							const targetOrigin = window.location.ancestorOrigins[0] || '*';
							//console.log(\`Widget: Sending \${messageType} message to parent (\${targetOrigin}):\`, text);
							// Use messageType in the object sent
							window.parent.postMessage({ type: messageType, text: text }, targetOrigin);
						} catch (err) {
							//console.error('Widget: Error sending message to parent:', err);
							// Determine error context based on messageType
							const errorContext = messageType === 'chatMessage' ? 'chat' : 'search';
							showError(errorContext, 'خطا در ارسال پیام به صفحه اصلی.');
							disableInput(errorContext, false);
							showLoading(errorContext, false);
							if (errorContext === 'chat') chatProcessing = false;
							else searchProcessing = false;
						}
					}
					// --- Tab Switching Logic ---
					function switchToTab(tabName) {
						//console.log('Widget: Switching to tab:', tabName);
						// Update button active states
						chatTabButton.classList.toggle('active', tabName === 'chat');
						searchTabButton.classList.toggle('active', tabName === 'search');

						// Update pane visibility
						chatTabContent.classList.toggle('active', tabName === 'chat');
						searchTabContent.classList.toggle('active', tabName === 'search');

						// Optionally focus input in the newly active tab
						if (tabName === 'chat' && !chatInputArea.classList.contains('hidden')) {
							chatInput.focus();
						} else if (tabName === 'search') {
							searchInput.focus();
						}
					}

					// --- Initialization Function ---
					function initializeWidget() {
						const shouldRemember = localStorage.getItem(LS_REMEMBER_FLAG) === 'true';

						if (shouldRemember) {
							const name = localStorage.getItem(LS_USER_NAME) || '';
							const contact = localStorage.getItem(LS_USER_CONTACT) || '';
							//console.log("Widget: Found 'Remember Me' flag. Name:", name, 'Contact:', contact);

							rememberedUserInfo = {
								// Populate global var
								name: name || null,
								contact: contact || null,
							};

							// Show welcome message
							if (name) {
								welcomeBackMessage.textContent = \`خوش آمدید، \${name}!\`;
							} else {
								welcomeBackMessage.textContent = \`خوش آمدید!\`;
							}
							welcomeBackMessage.style.display = 'block';

							// Hide form, show chat immediately
							userInfoForm.classList.add('hidden');
							chatInputArea.classList.remove('hidden');
							addInitialBotMessage('چگونه می‌توانم به شما کمک کنم؟'); // Add a follow-up greeting
							chatInput.focus();
						} else {
							//console.log("Widget: No 'Remember Me' flag found. Showing info form.");
							// Ensure form is visible and chat is hidden
							userInfoForm.classList.remove('hidden');
							chatInputArea.classList.add('hidden');
							addInitialBotMessage(
								'سلام! من مشاور هوش مصنوعی AlumGlass هستم. برای شروع گفتگو و شخصی‌سازی پاسخ‌ها، لطفاً اطلاعات زیر را (اختیاری) وارد نمایید.'
							);
						}
						// Clear chat messages on initial load? Optional.
						// chatMessagesDiv.innerHTML = '';
					}
					// Helper to add initial bot messages
					function addInitialBotMessage(text) {
						// Check if the message already exists to avoid duplicates on potential re-renders
						const existingMessages = chatMessagesDiv.querySelectorAll('.bot-message');
						let alreadyExists = false;
						existingMessages.forEach((msg) => {
							if (msg.textContent.includes(text)) {
								alreadyExists = true;
							}
						});

						if (!alreadyExists) {
							const initialMsgDiv = document.createElement('div');
							initialMsgDiv.classList.add('bot-message', 'message-base');
							initialMsgDiv.textContent = text;
							chatMessagesDiv.appendChild(initialMsgDiv);
						}
					}

					// --- Event Handlers ---
					function handleUserInfoSubmit(event) {
						event.preventDefault();
						const name = userNameInput.value.trim();
						const contact = userContactInput.value.trim();
						const remember = rememberMeCheckbox.checked;

						const userInfoToSend = {
							name: name || null,
							contact: contact || null,
						};
						//console.log('Widget: User info submitted:', userInfoToSend, 'Remember:', remember);

						if (remember) {
							localStorage.setItem(LS_REMEMBER_FLAG, 'true');
							localStorage.setItem(LS_USER_NAME, name);
							localStorage.setItem(LS_USER_CONTACT, contact);
							rememberedUserInfo = userInfoToSend; // Also set global var for immediate use
							//console.log('Widget: Saved info to localStorage.');
						} else {
							// Clear localStorage if user unchecks 'Remember Me' later (or on submit)
							localStorage.removeItem(LS_REMEMBER_FLAG);
							localStorage.removeItem(LS_USER_NAME);
							localStorage.removeItem(LS_USER_CONTACT);
							rememberedUserInfo = null; // Clear global var if not remembering
							//console.log('Widget: Cleared info from localStorage.');
						}

						// Hide form, show chat
						userInfoForm.classList.add('hidden');
						chatInputArea.classList.remove('hidden');
						welcomeBackMessage.style.display = 'none'; // Hide welcome message if it was shown
						if (rememberedUserInfo && rememberedUserInfo.name) {
							// Add personalized greeting
							addInitialBotMessage(\`ممنون، \${rememberedUserInfo.name}. حالا می‌توانید سوال خود را بپرسید.\`);
						} else {
							addInitialBotMessage('ممنون. حالا می‌توانید سوال خود را بپرسید.');
						}
						chatInput.focus();
					}

					async function handleSendChat() {
						const message = chatInput.value.trim();
						if (!message || chatProcessing) return;

						chatProcessing = true;
						addChatMessage('user', message, message);
						chatInput.value = '';
						disableInput('chat', true);
						showError('chat', null);
						showLoading('chat', true);

						// Prepare data to send
						const messageData = { text: message };

						// Check if we have *remembered* info (from localStorage init or form submit)
						// Only send it on the *first* message after initialization/form submit
						// We need a flag to track if we've already sent the info for this "session start"
						if (rememberedUserInfo) {
							messageData.userInfo = rememberedUserInfo;
							// Clear it so it's not sent with *every* message,
							// only the first one after loading/submitting the form.
							// The backend now relies on the cookie session for context.
							rememberedUserInfo = null;
						}

						sendMessageToParent('chatMessage', messageData);
					}

					async function handleVectorSearch() {
						const query = searchInput.value.trim();
						if (!query || searchProcessing) return;

						searchProcessing = true;
						resultsDiv.innerHTML = '';
						disableInput('search', true);
						showError('search', null);
						showLoading('search', true);

						sendMessageToParent('vectorSearch', query); // Pass 'vectorSearch' as type
					}

					// --- Event Listeners ---
					chatTabButton.addEventListener('click', () => switchToTab('chat'));
					searchTabButton.addEventListener('click', () => switchToTab('search'));
					startChatButton.addEventListener('click', handleUserInfoSubmit);
					chatSendButton.addEventListener('click', handleSendChat);
					chatInput.addEventListener('keypress', (e) => {
						if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault();
							handleSendChat();
						}
					});
					searchButton.addEventListener('click', handleVectorSearch);
					searchInput.addEventListener('keypress', (e) => {
						if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault();
							handleVectorSearch();
						}
					});
					// --- Listeners for top-right buttons ---
					copyLastButton.addEventListener('click', () => handleCopyLast(copyLastButton));
					shareChatButton.addEventListener('click', handleShareChat);

					// --- Listen for messages FROM Parent ---
					window.addEventListener('message', (event) => {
						//console.log('Parent Listener: Message EVENT received! Origin:', event.origin, 'Data:', event.data);
						// SECURITY: Origin check
						const allowedOrigins = [
							'https://alumglass.com',
							'http://localhost:8787',
							'http://127.0.0.1:8787',
							'http://localhost:3000',
							'http://127.0.0.1:3000',
						];
						// Use RegExp constructor for safety inside template literal
						const localhostRegex = new RegExp('^http:\\/\\/localhost:\\d+$');
						const loopbackRegex = new RegExp('^http:\\/\\/127\\.0\\.0\\.1:\\d+$');
						const isAllowedOrigin =
							allowedOrigins.includes(event.origin) || localhostRegex.test(event.origin) || loopbackRegex.test(event.origin);
						//console.log('Parent: Processing valid message from widget:', event.data);

						// ***Add safety check for event.data and event.data.type ***
						if (typeof event.data !== 'object' || event.data === null || !event.data.hasOwnProperty('type')) {
							//console.warn('Widget: Received malformed/typeless message data from parent:', event.data);
							return; // Ignore message without a 'type'
						}
						// *** End Correction ***
						if (!isAllowedOrigin) return;
						if (typeof event.data !== 'object' || event.data === null || !event.data.hasOwnProperty('type')) return;
						//console.log('Widget: Message received from parent:', event.data);
						// Now it's safe to destructure
						const { type, response, astraResults, results, message, sessionId } = event.data;

						if (type === 'chatResponse') {
							showLoading('chat', false);
							disableInput('chat', false);
							const rawBotText = response;
							const formattedMessage = formatBotResponse(rawBotText, astraResults);
							addChatMessage('bot', formattedMessage, rawBotText); // Pass raw text

							// --- Update state for action buttons ---
							lastBotMessageRawText = rawBotText; // Store raw text
							if (sessionId) {
								currentSessionId = sessionId;
							} // Store session ID if received
							chatActionsContainer.classList.remove('hidden'); // Show action buttons
							copyLastButton.disabled = false;
							shareChatButton.disabled = !navigator.share || !currentSessionId; // Disable share if no share API or session ID
							// --- End Update ---

							chatProcessing = false;
						} else if (type === 'chatError') {
							showLoading('chat', false);
							disableInput('chat', false);
							showError('chat', message || '...');
							chatProcessing = false;
						} else if (type === 'vectorSearchResponse') {
							showLoading('search', false);
							disableInput('search', false);
							displaySearchResults(results);
							searchProcessing = false;
						} else if (type === 'vectorSearchError') {
							showLoading('search', false);
							disableInput('search', false);
							showError('search', message || 'یک خطای ناشناخته در جستجوی برداری رخ داد.');
							resultsDiv.innerHTML = '';
							searchProcessing = false;
						}
					});
					// --- Initialize on Load ---
					document.addEventListener('DOMContentLoaded', () => {
						initializeWidget();
						switchToTab('chat'); // Ensure chat tab is active by default
					});
				</script>
			</body>
		</html>
	`;
};

// --- Hono App Setup ---
app.get('/widget', (c) => c.html(renderWidget()));

// --- API Endpoints ---

// CHAT API Endpoint
app.post('/api/webchat', async (c) => {
	const db = c.env.DB;
	const sessionId = c.get('sessionId');
	let requestData;
	try {
		requestData = await c.req.json();
	} catch (e) {
		console.error('Worker: Failed to parse request JSON', e);
		return c.json({ error: 'Invalid request format.' }, 400);
	}

	// Destructure potentially incoming userInfo
	const { text, userInfo } = requestData;
	if (typeof text !== 'string' || !text) {
		// Add check here too
		console.error(`Worker: Invalid 'text' received in /api/webchat request for session ${sessionId}. Received:`, text);
		return c.json({ error: 'Invalid message text provided.' }, 400);
	}
	if (!sessionId) return c.json({ error: 'Session ID not found.' }, 500);

	// Logging...
	if (userInfo) {
		console.log(`Worker: /api/webchat request for session ${sessionId} WITH UserInfo:`, userInfo, `Text: "${text}"`);
	} else {
		console.log(`Worker: /api/webchat request for session ${sessionId}: "${text}"`);
	}

	try {
		const history = await getChatHistory(db, sessionId, CHAT_HISTORY_LIMIT);
		const searchResults = { ddg: await ddgSearch(text), ccav: await codecave(text) }; /* ... google fallback ... */

		// Call Gemini via the new helper function
		const geminiResult = await queryGeminiChatWeb(text, searchResults, history, userInfo, c.env, text);

		// Check if the Gemini call itself failed unrecoverably
		if (!geminiResult.success) {
			// Use the error status/message from the helper function if available
			const status = geminiResult.error?.status || 500;
			const message = geminiResult.error?.message || 'خطا در ارتباط با سرویس هوش مصنوعی.';
			console.error(`Worker: Failing webchat request due to Gemini error. Status: ${status}, Message: ${message}`);
			return c.json({ error: message }, status);
		}

		// Success - extract results
		const { response: botResponseText, astraResults } = geminiResult.data;

		// Save messages (ensure botResponseText is string)
		await saveChatMessage(db, sessionId, 'user', text, userInfo?.name, userInfo?.contact);
		if (typeof botResponseText === 'string') {
			await saveChatMessage(db, sessionId, 'bot', botResponseText);
			console.log(`Worker: Messages saved for session ${sessionId}.`);
		} else {
			console.error(`Worker: Bot response was not a string for session ${sessionId}, cannot save to D1. Type: ${typeof botResponseText}`);
			// Optionally save a placeholder or log more details
			await saveChatMessage(db, sessionId, 'bot', '[Error: Invalid bot response format]');
		}
		// 5. Return response
		return c.json({
			response: botResponseText,
			astraResults: astraResults,
			sessionId: sessionId, // Include session ID for the widget
		});
	} catch (error) {
		console.error(`Worker: /api/webchat Error for session ${sessionId}:`, error, error.stack);
		return c.json({ error: `پردازش چت با خطا مواجه شد: ${error.message || 'Unknown error'}` }, 500);
	}
});

// VECTOR SEARCH API Endpoint
app.post('/api/widget-search', async (c) => {
	try {
		const { text } = await c.req.json(); // Only expect text here
		console.log(`Widget Worker: /api/widget-search request: "${text}"`);
		if (!text) return c.json({ error: 'لطفا عبارتی برای جستجو وارد کنید' }, 400);

		console.log(`Widget Worker: /api/widget-search request: "${text}"`);
		// ---Pass ONLY the text string ---
		const embeddingResult = await generateEmbedding(text, c.env);
		// --- End Correction ---

		// Check if embedding call failed
		if (!embeddingResult.success) {
			const status = embeddingResult.error?.status || 500;
			const message = embeddingResult.error?.message || 'خطا در تولید بردار جستجو.';
			console.error(`Worker: Failing search request due to embedding error. Status: ${status}, Message: ${message}`);
			return c.json({ error: message }, status);
		}

		const embedding = embeddingResult.data; // Extract the embedding vector
		if (!embedding) {
			// Should not happen if success is true, but double-check
			console.error('Worker: Embedding generation succeeded but returned no vector.');
			return c.json({ error: 'Embedding vector generation failed unexpectedly.' }, 500);
		}
		console.log(`Widget Worker: Embedding generated (dimension: ${embedding.length})`);

		// Search AstraDB (this part remains the same)
		const results = await searchAstraDB(embedding, c.env);
		console.log(`Widget Worker: AstraDB vector search found ${results.length} results.`);
		return c.json(results);
	} catch (error) {
		console.error('Widget Worker: UNEXPECTED /api/widget-search Error:', error, error.stack);
		return c.json({ error: `جستجوی برداری با خطای غیرمنتظره مواجه شد.` }, 500);
	}
});

// --- NEW API Endpoint: Get Full Chat History ---
app.get('/api/get-history/:sessionId', async (c) => {
	const db = c.env.DB;
	const sessionId = c.req.param('sessionId');

	if (!sessionId) {
		return c.json({ error: 'Session ID is required.' }, 400);
	}
	console.log(`Worker: API request to get history & user info for session: ${sessionId}`);

	try {
		const messages = await getAllChatHistory(db, sessionId); // Gets all messages
		const userInfo = await getLatestProvidedUserInfo(db, sessionId); // Gets latest provided info

		if ((!messages || messages.length === 0) && !userInfo) {
			return c.json({ error: 'Chat history and user info not found.' }, 404);
		}

		// Return both messages and userInfo
		return c.json({
			history: messages || [], // Ensure history is an array even if null
			userInfo: userInfo, // This will be null if no info was ever provided
		});
	} catch (error) {
		console.error(`Worker: Error fetching history/user info via API for session ${sessionId}:`, error);
		return c.json({ error: 'Failed to retrieve chat data.' }, 500);
	}
});
// --- Helper Functions ---

// Generate Embedding Function
async function generateEmbedding(text, env) {
	if (!env[GEMINI_EMBEDDING_KEY_VAR]) {
		console.error(`Worker: Embedding key var '${GEMINI_EMBEDDING_KEY_VAR}' not set!`);
		return { success: false, error: { status: 500, message: 'Embedding key not configured.' } };
	}
	if (typeof text !== 'string' || !text) {
		console.error('Widget Worker: Cannot embed non-string:', text);
		return { success: false, error: { status: 400, message: 'Invalid text for embedding.' } };
	}
	const MODEL_NAME = 'text-embedding-004'; // Specific model for embedding
	const endpointUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:embedContent`;
	const requestBody = { content: { parts: [{ text: text }] } }; // Correct structure for embedContent

	console.log('Worker: Calling fetchGeminiWithRetry for embedding...');
	const result = await fetchGeminiWithRetry(endpointUrl, requestBody, null, true, env); // Pass embedding flag = true

	if (result.success && result.data?.embedding?.values) {
		return { success: true, data: result.data.embedding.values }; // Return the vector
	} else {
		console.error('Worker: fetchGeminiWithRetry failed for embedding.', result.error);
		// Return the failure object from the helper
		return result; // Propagate the error details
	}
}
// Search AstraDB Function
async function searchAstraDB(vector, env) {
	if (!env.ASTRA_DB_ENDPOINT || !env.ASTRA_KEYSPACE || !env.ASTRA_COLLECTION_NAME || !env.ASTRA_DB_TOKEN) {
		console.error('Widget Worker: AstraDB env vars not set for search!');
		return [];
	}
	if (!vector || !Array.isArray(vector) || vector.length === 0) {
		console.error('Widget Worker: Invalid vector for AstraDB search.');
		return [];
	}
	try {
		const baseUrl = env.ASTRA_DB_ENDPOINT.replace(/\/$/, '');
		const searchUrl = `${baseUrl}/api/json/v1/${env.ASTRA_KEYSPACE}/${env.ASTRA_COLLECTION_NAME}`;
		const astraRequestBody = {
			find: {
				sort: { $vector: vector },
				options: { limit: 10, includeSimilarity: true },
				projection: { _id: 0, content: 1, 'metadata.doc_name': 1, 'metadata.references': 1 },
			},
		};
		// console.log("Widget Worker: Querying AstraDB for vector search:", searchUrl); // Less verbose
		const astraResponse = await fetch(searchUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Cassandra-Token': env.ASTRA_DB_TOKEN },
			body: JSON.stringify(astraRequestBody),
		});
		if (!astraResponse.ok) {
			const astraErrorText = await astraResponse.text();
			console.error(`Widget Worker: AstraDB Vector Search Error (${astraResponse.status}):`, astraErrorText);
			return [];
		} else {
			const results = await astraResponse.json();
			return results.data?.documents || [];
		}
	} catch (astraError) {
		console.error('Widget Worker: Error during AstraDB vector search:', astraError);
		return [];
	}
}

// DuckDuckGo Search (with corrected entity decoding)
async function ddgSearch(query) {
	const encodedQuery = encodeURIComponent(query);
	const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;
	try {
		const response = await fetch(url, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
				Accept:
					'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
				'Accept-Language': 'en-US,en;q=0.9,fa;q=0.8',
				Referer: 'https://duckduckgo.com/',
				'Sec-Fetch-Dest': 'document',
				'Sec-Fetch-Mode': 'navigate',
				'Sec-Fetch-Site': 'same-origin',
				'Sec-Fetch-User': '?1',
				'Upgrade-Insecure-Requests': '1',
			},
			redirect: 'follow',
		});
		if (!response.ok) {
			console.error(`Widget Worker: DDG Search failed status: ${response.status}`);
			return [];
		}
		const html = await response.text();
		const results = [];
		const regex = /<a class="result__a".*?href="(.*?)".*?>(.*?)<\/a>/gs;
		let match;
		while ((match = regex.exec(html)) !== null && results.length < 5) {
			try {
				const rawUrl = match[1];
				// ***Use proper entity names ***
				const title = match[2]
					.replace(/<[^>]+>/g, '')
					.replace(/&/g, '&')
					.replace(/"/g, '"')
					.trim();
				let actualUrl = rawUrl;
				if (rawUrl.startsWith('/l/')) {
					const urlParams = new URLSearchParams(rawUrl.split('?')[1]);
					actualUrl = urlParams.get('uddg') || rawUrl;
				}
				actualUrl = actualUrl.replace(/&/g, '&'); // Also decode in URL
				const snippetRegex = new RegExp(
					`<a class="result__a".*?href="${match[1].replace(/\"/g, '"')}">.*?</a>.*?<a class="result__snippet".*?>(.*?)</a>`,
					'gs'
				); // Escape quotes in href for regex
				const snippetMatch = snippetRegex.exec(html);
				// ***Use proper entity names ***
				const description = snippetMatch
					? snippetMatch[1]
							.replace(/<[^>]+>/g, '')
							.replace(/&/g, '&')
							.replace(/"/g, '"')
							.trim()
					: '';
				if (actualUrl && title) {
					results.push({ title: title, link: decodeURIComponent(actualUrl), description: description });
				}
			} catch (urlError) {
				console.warn('Widget Worker: DDG parsing issue:', urlError);
			}
		}
		return results;
	} catch (error) {
		console.error('Widget Worker: DDG Search Error:', error);
		return [];
	}
}

// Google Search
// async function googleSearch(query, env) {
// 	if (!env.GOOGLE_API_KEY || !env.GOOGLE_CSE_ID) {
// 		/* Warned elsewhere */ return [];
// 	}
// 	const url = `https://www.googleapis.com/customsearch/v1?key=${env.GOOGLE_API_KEY}&cx=${env.GOOGLE_CSE_ID}&q=${encodeURIComponent(
// 		query
// 	)}&num=5`;
// 	try {
// 		const response = await fetch(url);
// 		if (!response.ok) {
// 			const errorData = await response.json();
// 			console.error(`Widget Worker: Google Search API Error (${response.status}):`, errorData.error?.message || response.statusText);
// 			return [];
// 		}
// 		const data = await response.json();
// 		return data.items?.map((item) => ({ title: item.title, link: item.link, description: item.snippet })) || [];
// 	} catch (error) {
// 		console.error('Widget Worker: Google Search Fetch Error:', error);
// 		return [];
// 	}
// }

// CCAV Search (with corrected entity decoding)
async function codecave(query) {
	const encodedQuery = encodeURIComponent(`site:codekav.ir ${query}`);
	const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;
	try {
		const response = await fetch(url, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
				Accept:
					'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
				'Accept-Language': 'en-US,en;q=0.9,fa;q=0.8',
				Referer: 'https://duckduckgo.com/',
				'Sec-Fetch-Dest': 'document',
				'Sec-Fetch-Mode': 'navigate',
				'Sec-Fetch-Site': 'same-origin',
				'Sec-Fetch-User': '?1',
				'Upgrade-Insecure-Requests': '1',
			},
			redirect: 'follow',
		});
		if (!response.ok) {
			console.error(`Widget Worker: codecav failed status: ${response.status}`);
			return [];
		}
		const html = await response.text();
		const results = [];
		const regex = /<a class="result__a".*?href="(.*?)".*?>(.*?)<\/a>/gs;
		let match;
		while ((match = regex.exec(html)) !== null && results.length < 3) {
			try {
				const rawUrl = match[1];
				// ***Use proper entity names ***
				const title = match[2]
					.replace(/<[^>]+>/g, '')
					.replace(/&/g, '&')
					.replace(/"/g, '"')
					.trim();
				let actualUrl = rawUrl;
				if (rawUrl.startsWith('/l/')) {
					const urlParams = new URLSearchParams(rawUrl.split('?')[1]);
					actualUrl = urlParams.get('uddg') || rawUrl;
				}
				actualUrl = actualUrl.replace(/&/g, '&'); // Also decode in URL
				if (actualUrl && title && actualUrl.includes('codekav.ir')) {
					const snippetRegex = new RegExp(
						`<a class="result__a".*?href="${match[1].replace(/\"/g, '"')}">.*?</a>.*?<a class="result__snippet".*?>(.*?)</a>`,
						'gs'
					); // Escape quotes
					const snippetMatch = snippetRegex.exec(html);
					// ***Use proper entity names ***
					const description = snippetMatch
						? snippetMatch[1]
								.replace(/<[^>]+>/g, '')
								.replace(/&/g, '&')
								.replace(/"/g, '"')
								.trim()
						: '';
					results.push({ title: title, link: decodeURIComponent(actualUrl), description: description });
				}
			} catch (urlError) {
				console.warn('Widget Worker: codecav parsing issue:', urlError);
			}
		}
		return results;
	} catch (error) {
		console.error('Widget Worker: codecav Search Error:', error);
		return [];
	}
}

// Gemini Chat for Web
// Gemini Chat for Web (Corrected API Key Usage)
async function queryGeminiChatWeb(text, searchResults, chatHistory, userInfo, env, originalQuery = null) {
	// Added chatHistory param

	// Format Web Search Results (as before)
	const formattedSearchResults =
		Object.entries(searchResults)
			.filter(([_, results]) => results.length > 0)
			.map(([source, results]) => {
				const sourceName = source === 'ddg' ? 'DDG' : source === 'google' ? 'Google' : source === 'ccav' ? 'CCAV' : 'Web';
				const resultLines = results.map((r, i) => `${i + 1}. **${r.title}**: ${r.description || '_'} [لینک](${r.link})`).join('\n');
				return `*نتایج ${sourceName}:*\n${resultLines}`;
			})
			.join('\n\n') || 'نتایج وب یافت نشد.';

	// Format Chat History for the prompt
	const formattedHistory =
		chatHistory && chatHistory.length > 0
			? chatHistory.map((msg) => `${msg.role}: ${msg.content}`).join('\n')
			: 'هیچ تاریخچه گفتگوی قبلی وجود ندارد.';

	// Fetch AstraDB docs (as before)
	let astraDocs = 'پایگاه داده جستجو نشد یا نتیجه‌ای نداشت.';
	let astraResults = [];
	try {
		// --- ADD LOGGING &Use originalQuery for embedding ---
		const textToEmbed = originalQuery || text; // Prefer originalQuery if available
		console.log(`Worker: Attempting to generate embedding for text (type: ${typeof textToEmbed}): "${textToEmbed}"`); // Log type and value
		const embeddingResult = await generateEmbedding(textToEmbed, env); // Use the verified text string
		// --- End Logging & Correction ---

		if (embeddingResult.success) {
			astraResults = await searchAstraDB(embeddingResult.data, env); // Use the helper function
			if (astraResults.length > 0) {
				astraDocs =
					'نتایج پایگاه داده:\n' +
					astraResults
						.map((doc, index) => {
							return `${index + 1}. **کتاب:** ${doc.metadata?.doc_name || '?'} | **بخش:** ${
								doc.metadata?.references || '?'
							} | **شباهت:** ${(doc.$similarity * 100).toFixed(1)}%\n   **متن:** ${doc.content?.substring(0, 200) || '?'}...`; // Shorter context
						})
						.join('\n');
			} else {
				astraDocs = 'سند مرتبطی در پایگاه داده یافت نشد.';
			}
		} else {
			astraDocs = `خطا در پردازش جستجوی پایگاه داده (${embeddingResult.error?.message || 'embedding failed'}).`;
			console.log('Worker: Skipping AstraDB search due to embedding failure.');
		}
	} catch (astraError) {
		console.error('Worker: Chat AstraDB Error:', astraError);
		astraDocs = 'خطا در جستجوی پایگاه داده.';
	}

	let userInfoForPrompt = 'کاربر گرامی'; // Default
	if (userInfo && (userInfo.name || userInfo.contact)) {
		// Check if either name or contact exists
		let namePart = userInfo.name || '';
		let contactPart = userInfo.contact ? `(${userInfo.contact})` : '';
		userInfoForPrompt = `${namePart} ${contactPart}`.trim();
		if (userInfoForPrompt === '()' || !userInfoForPrompt) userInfoForPrompt = 'کاربر گرامی'; // Better fallback
	}
	const queryForPrompt = originalQuery || text;
	// --- Build the Final Prompt (INCLUDING HISTORY) ---
	const prompt = `
You are AlumGlass, a highly specialized AI assistant providing expert guidance on Iran's National Building Regulations (Mabhath). Your purpose is to deliver detailed, accurate, and well-reasoned answers based **primarily** on official Iranian standards and supplementary technical documents from your knowledge base. You MUST respond ONLY in PERSIAN (Farsi).

**Core Directives:**
1.  **Prioritize Sources STRICTLY:** Mabhath (1-23) > Publication 714 (Facades) > General Conditions of Contract (Sharayet Omumi Peyman) > Mabhath 3 (Fire) > **Knowledge Base Documents** > General Knowledge/Training Data > Web Search Results. **Official standards are the ultimate authority.**
2.  **Cite Rigorously:** Every piece of information derived from a specific source MUST be cited immediately with the regulation number (e.g., "طبق بند ۱۹-۱-۵-۲ مبحث ۱۹...") or document reference (e.g., "بر اساس نشریه ۷۱۴، بخش ...", "**طبق [نام کتاب یا سند از دانش فنی]، بخش/رفرنس [شماره/عنوان بخش]...**"). Web results should be cited by title/source ("بر اساس نتیجه جستجوی وب از [منبع] با عنوان '[عنوان]'..."). General knowledge should be indicated ("بر اساس دانش عمومی مهندسی..."). **DO NOT mention the underlying database name (like Astra DB).**
3.  **Think Step-by-Step (Internal Monologue - DO NOT include in final response):** Before generating the user-facing answer, mentally outline your plan:
    *   Identify the core engineering/regulatory question(s).
    *   Determine the primary relevant Mabhath section(s) or other high-priority documents.
    *   Analyze information from the highest priority source first.
    *   Consult relevant **Knowledge Base Documents** provided below. Note any direct support or contradictions with standards. **Treat these documents as authoritative technical references supplementing the main standards.**
    *   *Only if necessary*, consult web search results. Critically evaluate web results against standards and Knowledge Base Documents.
    *   Check for contradictions between *any* sources (Knowledge Base vs Mabhath, Web vs Mabhath, etc.).
    *   Determine if calculations based on standard formulas are required.
    *   Plan the structure of the detailed Persian response.
4.  **Detailed & Comprehensive Answers:** Provide thorough explanations. Explain context, purpose, and implications. Break down complex topics. Aim for educational value.
5.  **Contradiction Handling:** If contradictions are found:
    *   **ALWAYS** prioritize the official standard (Mabhath > Pub 714 > etc.).
    *   Explicitly state the contradiction found (e.g., "در حالی که در [نام کتاب یا سند از دانش فنی] اشاره شده...، بند صریح مبحث ۱۹ بیان می‌دارد که... لذا مبحث ۱۹ ملاک عمل است.").
    *   Explain *why* the standard takes precedence.
6.  **Utilizing Knowledge Base:** Seamlessly integrate relevant information from the **Knowledge Base Documents** provided below into your answer where appropriate, citing them correctly (Directive #2). **DO NOT state whether the search for these documents was successful or if information was found/not found.** Simply use the information if relevant, or rely on other sources if not.
7.  **Engineering Calculations:** If the query requires calculations based on formulas within the standards or **Knowledge Base Documents**:
    *   Identify the relevant formula(s) and **cite their source precisely**.
    *   Define variables. Perform an **example calculation** showing steps clearly. State assumptions. Present result with units. Explain significance.
    *   Add disclaimer: "این یک محاسبه نمونه است؛ محاسبات دقیق نیازمند بررسی کامل توسط مهندس می‌باشد."
8.  **Clarification:** Ask specific clarifying questions if the user's query is ambiguous.
9.  **Confidence Level:** State your confidence level (پایین، متوسط، بالا) based on source availability/consistency and complexity. Justify if not High.
10. **Self-Correction/Review (Internal Check - DO NOT include in final response):** Review your generated response against these points: Persian only? Addresses query? Detailed? Prioritization followed? Citations correct and immediate? Contradictions handled? Calculations correct & caveated? Confidence stated? Professional tone?

**Input Data:**

*   **User Information:** ${userInfoForPrompt}
*   **Previous Conversation History (Oldest to Newest):**
    ${formattedHistory}
*   **Current User Query:** ${queryForPrompt}
*   **Knowledge Base Documents (Internal Technical References - HIGH PRIORITY after official standards):**
    ${astraDocs}
    *Cite using format: طبق [نام کتاب یا سند از دانش فنی], بخش/رفرنس [شماره/عنوان بخش]...*
*   **Web Search Results (Supplementary - LOWER PRIORITY):**
    ${formattedSearchResults}
    *Cite using format: بر اساس نتیجه جستجوی وب از [منبع] با عنوان '[عنوان]'...*

**Final Output Instruction:**
Generate **ONLY** the comprehensive, well-cited, Persian response for the user, following all directives above. Do NOT output your internal thought process, self-review checklist, or comments about the search process for Knowledge Base Documents.
`;
	// --- End Prompt Update ---

	const MODEL_NAME = 'gemini-2.5-pro-exp-03-25'; // Use Flash for potentially faster widget response
	const endpointUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent`;

	const requestBody = { contents: [{ parts: [{ text: prompt }] }], generationConfig: {} };

	console.log('Worker: Calling fetchGeminiWithRetry for chat response...');
	const result = await fetchGeminiWithRetry(endpointUrl, requestBody, GEMINI_CHAT_KEY_ORDER, false, env); // Pass chat key order

	if (result.success && result.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
		const responseText = result.data.candidates[0].content.parts[0].text;
		// Return success along with the data needed by the API handler
		return { success: true, data: { response: responseText, astraResults: astraResults } };
	} else if (result.success) {
		// Success but unexpected response structure
		console.error('Worker: Gemini chat call succeeded but response format unexpected:', result.data);
		const finishReason = result.data?.candidates?.[0]?.finishReason;
		let errMsg = 'پاسخ نامعتبر از سرویس هوش مصنوعی دریافت شد.';
		if (finishReason === 'SAFETY') errMsg = 'پاسخ به دلیل محدودیت ایمنی مسدود شد.';
		else if (finishReason === 'RECITATION') errMsg = 'پاسخ به دلیل تکرار محتوای محافظت شده مسدود شد.';
		else if (finishReason === 'MAX_TOKENS') errMsg = 'پاسخ کامل نشد (محدودیت طول).';
		return { success: false, error: { status: 500, message: errMsg } };
	} else {
		// Fetch helper already failed, propagate the error
		console.error('Worker: fetchGeminiWithRetry failed for chat.', result.error);
		return result; // Contains { success: false, error: {...} }
	}
}

// --- Export the Hono app ---
export default app;
