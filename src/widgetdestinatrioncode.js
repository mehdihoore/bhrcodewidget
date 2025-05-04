// --- PARENT PAGE JAVASCRIPT (alumglass.com) ---
const widgetIframe = document.getElementById('ai-widget-iframe');
const widgetWorkerBaseUrl = 'https://bhrwidget.aihoore.ir';
const widgetOrigin = widgetWorkerBaseUrl;
const widgetWorkerChatApiUrl = `${widgetWorkerBaseUrl}/api/webchat`;
const widgetWorkerSearchApiUrl = `${widgetWorkerBaseUrl}/api/widget-search`;

// --- NEW: Variable to hold user info if sent from widget ---
// let collectedUserInfoFromWidget = null; // We don't strictly need this if only sending once

if (widgetIframe) {
    console.log("Parent Script (alumglass.com): Attaching message listener.");

    window.addEventListener('message', async (event) => {
        console.log("Parent Listener (alumglass.com): Message EVENT received! Origin:", event.origin, "Data:", event.data);

        // --- Origin & Data Checks (Keep as before) ---
        if (event.origin !== widgetOrigin) { console.warn(`Parent Listener: IGNORED message from unexpected origin: ${event.origin}. Expected: ${widgetOrigin}`); return; }
        if (typeof event.data !== 'object' || event.data === null || !event.data.hasOwnProperty('type')) { console.warn("Parent Listener: IGNORED malformed/typeless message data from widget:", event.data); return; }

        console.log("Parent Listener: Processing VALID message from widget:", event.data);
        // Destructure all possible fields from widget message
        const { type, text, userInfo /* Add userInfo */ } = event.data;

        // --- Handle CHAT Message ---
        if (type === 'chatMessage') {
             // --- MODIFIED: Prepare body, include userInfo if present ---
             const requestBody = { text: text };
             if (userInfo) {
                  requestBody.userInfo = userInfo; // Add user info from widget message
                  console.log("Parent: Including collected user info in API call.");
             }
             // --- End Modification ---

            console.log(`Parent: Handling 'chatMessage'. Calling API: ${widgetWorkerChatApiUrl}`);
            try {
                const response = await fetch(widgetWorkerChatApiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    // Send the potentially modified body
                    body: JSON.stringify(requestBody),
                });
                // ... rest of chat success/error handling as before ...
                 console.log(`Parent: API call for chat completed. Status: ${response.status}`); if (!response.ok) { let e = { m: `API Chat Error: ${response.status}` }; try { e.m = (await response.json()).error || e.m; } catch {} throw new Error(e.m); } const result = await response.json(); console.log("Parent: Parsed chat API result:", result); if (widgetIframe.contentWindow) { const msg = { type: 'chatResponse', response: result.response, astraResults: result.astraResults }; console.log("Parent: Sending 'chatResponse' back to widget origin:", widgetOrigin); widgetIframe.contentWindow.postMessage(msg, widgetOrigin); } else { console.error("Parent: Cannot find widget contentWindow (chat response)."); }
            } catch (error) { /* ... error handling as before ... */ }
        }
        // --- Handle VECTOR SEARCH Message --- (No change needed here)
        else if (type === 'vectorSearch') {
             // userInfo is not relevant for vector search
             const requestBody = { text: text };
             console.log(`Parent: Handling 'vectorSearch'. Calling API: ${widgetWorkerSearchApiUrl}`);
             try { /* ... fetch API call for search ... */
                 const response = await fetch(widgetWorkerSearchApiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody), }); console.log(`Parent: API call for search completed. Status: ${response.status}`); if (!response.ok) { let e = { m: `API Search Error: ${response.status}` }; try { e.m = (await response.json()).error || e.m; } catch {} throw new Error(e.m); } const results = await response.json(); console.log("Parent: Parsed search API result:", results); if (widgetIframe.contentWindow) { const msg = { type: 'vectorSearchResponse', results: results }; console.log("Parent: Sending 'vectorSearchResponse' back to widget origin:", widgetOrigin); widgetIframe.contentWindow.postMessage(msg, widgetOrigin); } else { console.error("Parent: Cannot find widget contentWindow (search response)."); }
             } catch (error) { /* ... error handling ... */ }
        }
        // --- OPTIONAL: Handle userInfoCollected message if needed ---
        // else if (type === 'userInfoCollected') {
        //     console.log("Parent: Received user info from widget:", userInfo);
        //     // Store it if you need it for other parent-side logic
        //     // collectedUserInfoFromWidget = userInfo;
        // }
        else { console.warn("Parent Listener: Received unknown message type:", type); }
    });
} else { /* ... iframe not found error log ... */ }

</script>