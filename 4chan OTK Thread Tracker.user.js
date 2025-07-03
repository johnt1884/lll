// ==UserScript==
// @name         4chan OTK Thread Tracker
// @namespace    http://tampermonkey.net/
// @version      1.6
// @description  Tracks OTK threads on /b/, stores messages, shows top bar with colors and controls
// @match        https://boards.4chan.org/b/
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // Constants for storage keys
    const THREADS_KEY = 'otkActiveThreads';
    const MESSAGES_KEY = 'otkMessagesByThreadId';
    const COLORS_KEY = 'otkThreadColors';

    // Global Variables for Background Fetch Control
    let backgroundRefreshIntervalId = null;
    let isManualRefreshInProgress = false;
    const BACKGROUND_REFRESH_INTERVAL = 3000 * 50000; // 50 minute

    // Color palette for squares
    const COLORS = [
        '#e6194B', '#3cb44b', '#ffe119', '#4363d8', '#f58231',
        '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe',
        '#008080', '#e6beff', '#9A6324', '#fffac8', '#800000',
        '#aaffc3', '#808000', '#ffd8b1', '#000075', '#808080'
    ];

    // Create and insert black bar if not exists
    let bar = document.getElementById('otk-thread-bar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'otk-thread-bar';
        bar.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            background: black;
            color: white;
            font-family: Verdana, sans-serif;
            font-size: 14px;
            z-index: 9999;
            padding: 6px 12px 6px 12px;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            user-select: none;
        `;
        document.body.style.paddingTop = '90px'; // reserve space for bar + buttons below
        document.body.insertBefore(bar, document.body.firstChild);
    }

    // Create containers for top and bottom row inside bar
    let topRow = document.createElement('div');
    let bottomRow = document.createElement('div');
    topRow.style.cssText = 'display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;';
    bottomRow.style.cssText = 'display: flex; justify-content: flex-end; gap: 10px;';

    bar.appendChild(topRow);
    bar.appendChild(bottomRow);

    // Left side (thread list)
    let threadList = document.createElement('div');
    threadList.style.cssText = 'display: flex; gap: 15px; flex-wrap: wrap; align-items: flex-start; max-width: 70vw; overflow-x: auto;';
    topRow.appendChild(threadList);

    // Right side (Thread Tracker text)
    let trackerText = document.createElement('div');
    trackerText.textContent = 'Thread Tracker';
    trackerText.style.cssText = 'font-weight: bold; font-size: 16px; margin-top: 2px;';
    topRow.appendChild(trackerText);

    // Buttons container on bottom right
    let btnToggleViewer = document.createElement('button');
    btnToggleViewer.textContent = 'Toggle Viewer';
    btnToggleViewer.style.cssText = 'padding: 4px 10px; cursor: pointer;';

    let btnRefresh = document.createElement('button');
    btnRefresh.textContent = 'Refresh Threads/Messages';
    btnRefresh.style.cssText = 'padding: 4px 10px; cursor: pointer;';

    let btnClearRefresh = document.createElement('button');
    btnClearRefresh.textContent = 'Clear and Refresh';
    btnClearRefresh.style.cssText = 'padding: 4px 10px; cursor: pointer;';

    bottomRow.appendChild(btnToggleViewer);
    bottomRow.appendChild(btnRefresh);
    bottomRow.appendChild(btnClearRefresh);

    // Load from localStorage or initialize
    let activeThreads = JSON.parse(localStorage.getItem(THREADS_KEY)) || [];
    let messagesByThreadId = JSON.parse(localStorage.getItem(MESSAGES_KEY)) || {};
    let threadColors = JSON.parse(localStorage.getItem(COLORS_KEY)) || {};

    // Utility to decode HTML entities
    function decodeEntities(encodedString) {
        const txt = document.createElement('textarea');
        txt.innerHTML = encodedString;
        return txt.value;
    }

    // Get unique color for thread, or assign new
    function getThreadColor(threadId) {
        if (!threadColors[threadId]) {
            const usedColors = new Set(Object.values(threadColors));
            const availableColors = COLORS.filter(c => !usedColors.has(c));
            threadColors[threadId] = availableColors.length ? availableColors[0] : '#888';
            localStorage.setItem(COLORS_KEY, JSON.stringify(threadColors));
        }
        return threadColors[threadId];
    }

    // Render threads in black bar left side
    function renderThreadList() {
        threadList.innerHTML = '';
        activeThreads.forEach(threadId => {
            let color = getThreadColor(threadId);
            let msgs = messagesByThreadId[threadId] || [];
            // Get thread title from first message (if exists) or fallback "Untitled"
            let title = msgs.length > 0 && msgs[0].title ? decodeEntities(msgs[0].title) : 'Untitled';
            // Get date/time from first message in thread
            let dateStr = '';
            if (msgs.length > 0 && msgs[0].time) {
                let dt = new Date(msgs[0].time * 1000);
                dateStr = dt.toLocaleString();
            }

            let threadEl = document.createElement('div');
            threadEl.style.cssText = 'display: flex; align-items: center; gap: 6px;';

            let square = document.createElement('div');
            square.style.cssText = `
                width: 15px;
                height: 15px;
                background-color: ${color};
                flex-shrink: 0;
                border-radius: 2px;
            `;

            let titleSpan = document.createElement('span');
            titleSpan.textContent = title;

            let dateSpan = document.createElement('span');
            dateSpan.textContent = ` [${dateStr}]`;
            dateSpan.style.fontStyle = 'normal';

            threadEl.appendChild(square);
            threadEl.appendChild(titleSpan);
            threadEl.appendChild(dateSpan);

            threadList.appendChild(threadEl);
        });
    }

    // Scan catalog for threads with "OTK" (case-insensitive)
    async function scanCatalog() {
        const url = 'https://a.4cdn.org/b/catalog.json';
        const response = await fetch(url);
        const catalog = await response.json();

        let foundThreads = [];
        catalog.forEach(page => {
            page.threads.forEach(thread => {
                // Look for "OTK" in title or comment (case-insensitive)
                let title = thread.sub || '';
                let com = thread.com || '';
                if ((title + com).toLowerCase().includes('otk')) {
                    foundThreads.push({
                        id: thread.no,
                        title: title || 'Untitled'
                    });
                }
            });
        });
        return foundThreads;
    }

    // Fetch messages for a thread by JSON API
    async function fetchThreadMessages(threadId) {
        const url = `https://a.4cdn.org/b/thread/${threadId}.json`;
        const response = await fetch(url);
        if (!response.ok) return [];
        const threadData = await response.json();
        if (!threadData.posts) return [];
        // Map posts to simpler message objects
        return threadData.posts.map(post => {
            const message = {
                id: post.no,
                time: post.time,
                text: post.com ? post.com.replace(/<br>/g, '\n').replace(/<.*?>/g, '') : '',
                title: threadData.posts[0].sub || 'Untitled', // Title from the OP for all messages in thread
                attachment: null
            };
            if (post.filename) { // Check if filename exists, indicating an attachment
                message.attachment = {
                    filename: post.filename,
                    ext: post.ext,
                    tn_w: post.tn_w,
                    tn_h: post.tn_h,
                    tim: post.tim,
                    w: post.w,
                    h: post.h
                };
            }
            return message;
        });
    }

async function backgroundRefreshThreadsAndMessages() {
    if (isManualRefreshInProgress) {
        console.log('[OTK Tracker BG] Manual refresh in progress, skipping background refresh.');
        return;
    }
    console.log('[OTK Tracker BG] Performing background refresh...'); // LOG A
    try {
        // --- Add logs around major operations ---
        console.log('[OTK Tracker BG] Calling scanCatalog...'); // LOG B1
        const foundThreads = await scanCatalog();
        console.log(`[OTK Tracker BG] scanCatalog found ${foundThreads.length} threads.`); // LOG B2
        const foundIds = new Set(foundThreads.map(t => t.id));

        foundThreads.forEach(t => {
            if (!activeThreads.includes(t.id)) {
                activeThreads.push(t.id);
            }
        });

        activeThreads = activeThreads.filter(threadId => {
            const stillInCatalog = foundIds.has(threadId);
            const hasMessages = messagesByThreadId[threadId] && messagesByThreadId[threadId].length > 0;
            return stillInCatalog || hasMessages;
        });
        console.log(`[OTK Tracker BG] Active threads count after catalog scan: ${activeThreads.length}`); // LOG C

        for (const threadId of activeThreads) {
            console.log(`[OTK Tracker BG] Fetching messages for thread ${threadId}...`); // LOG D1
            let newMessages = await fetchThreadMessages(threadId);
            console.log(`[OTK Tracker BG] Fetched ${newMessages.length} new messages for thread ${threadId}.`); // LOG D2
            if (newMessages.length > 0) {
                let existing = messagesByThreadId[threadId] || [];
                let existingIds = new Set(existing.map(m => m.id));
                let merged = existing.slice();
                newMessages.forEach(m => {
                    if (!existingIds.has(m.id)) {
                        merged.push(m);
                        existingIds.add(m.id);
                    }
                });
                merged.sort((a, b) => a.time - b.time);
                messagesByThreadId[threadId] = merged;
            }
        }

        console.log('[OTK Tracker BG] Saving data to localStorage...'); // LOG E1
        localStorage.setItem(THREADS_KEY, JSON.stringify(activeThreads));
        localStorage.setItem(MESSAGES_KEY, JSON.stringify(messagesByThreadId));
        console.log('[OTK Tracker BG] Data saved. Dispatching otkMessagesUpdated event.'); // LOG E2
        // Colors are NOT updated by background refresh

        window.dispatchEvent(new CustomEvent('otkMessagesUpdated'));

        console.log('[OTK Tracker BG] Background refresh complete.'); // LOG F
    } catch (error) {
        console.error('[OTK Tracker BG] Error during background refresh:', error.message, error.stack); // Enhanced error log
    }
}

    // Refresh threads and messages without clearing storage
async function refreshThreadsAndMessages() {
    console.log('[OTK Tracker Manual] Refreshing threads and messages (core logic)...');
    try {
        const foundThreads = await scanCatalog();
        let foundIds = foundThreads.map(t => t.id);

        foundThreads.forEach(t => {
            if (!activeThreads.includes(t.id)) {
                activeThreads.push(t.id);
                getThreadColor(t.id); // Assign color if new thread
            }
        });

        activeThreads = activeThreads.filter(tid => foundIds.includes(tid) || (messagesByThreadId[tid] && messagesByThreadId[tid].length > 0));

        for (const threadId of activeThreads) {
            let newMessages = await fetchThreadMessages(threadId);
            if (newMessages.length > 0) {
                let existing = messagesByThreadId[threadId] || [];
                let existingIds = new Set(existing.map(m => m.id));
                let merged = existing.slice();
                newMessages.forEach(m => {
                    if (!existingIds.has(m.id)) {
                        merged.push(m);
                    }
                });
                merged.sort((a, b) => a.time - b.time);
                messagesByThreadId[threadId] = merged;
            }
        }

        localStorage.setItem(THREADS_KEY, JSON.stringify(activeThreads));
        localStorage.setItem(MESSAGES_KEY, JSON.stringify(messagesByThreadId));
        localStorage.setItem(COLORS_KEY, JSON.stringify(threadColors));

        renderThreadList();
        window.dispatchEvent(new CustomEvent('otkMessagesUpdated'));
        console.log('[OTK Tracker Manual] Core refresh actions complete.');
    } catch (error) {
        console.error('[OTK Tracker Manual] Error during core refresh:', error);
    }
}

    // Clear all data and refresh fully
async function clearAndRefresh() {
    console.log('[OTK Tracker Clear] Clear and Refresh initiated...');
    isManualRefreshInProgress = true;
    try {
        activeThreads = [];
        messagesByThreadId = {};
        threadColors = {};
        localStorage.removeItem(THREADS_KEY);
        localStorage.removeItem(MESSAGES_KEY);
        localStorage.removeItem(COLORS_KEY);

        console.log('[OTK Tracker Clear] LocalStorage cleared. Calling refreshThreadsAndMessages...');
        await refreshThreadsAndMessages();

        // Dispatch an event for the viewer to clear its display
        console.log('[OTK Tracker Clear] Dispatching otkClearViewerDisplay event.');
        window.dispatchEvent(new CustomEvent('otkClearViewerDisplay'));

        // renderThreadList is called by refreshThreadsAndMessages. If an extra one is needed, it can be added.
        // The current refreshThreadsAndMessages calls renderThreadList() and also getThreadColor for new threads.
        console.log('[OTK Tracker Clear] Clear and Refresh complete.');
    } catch (error) {
        console.error('[OTK Tracker Clear] Error during clear and refresh:', error);
    } finally {
        isManualRefreshInProgress = false;
        console.log('[OTK Tracker Clear] Manual refresh flag reset by clearAndRefresh.');
    }
}

    // Button event handlers
    btnToggleViewer.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('otkToggleViewer'));
    });

btnRefresh.addEventListener('click', async () => {
    console.log('[OTK Tracker] "Refresh Threads/Messages" button clicked: This will fetch the latest thread list and messages from 4chan, merging them with any locally stored data. The viewer will then be updated to show any new messages at the bottom.');
    sessionStorage.setItem('otkManualRefreshClicked', 'true'); // <--- ADD THIS LINE
    btnRefresh.disabled = true;
    isManualRefreshInProgress = true;
    console.log('[OTK Tracker] Refresh button clicked, manual refresh process starting.');
    try {
        await refreshThreadsAndMessages();
    } catch (error) {
        console.error("Error directly from btnRefresh event:", error);
    } finally {
        isManualRefreshInProgress = false;
        btnRefresh.disabled = false;
        console.log('[OTK Tracker] Refresh button process finished, flag reset.');
    }
});

btnClearRefresh.addEventListener('click', async () => {
    console.log('[OTK Tracker] "Clear and Refresh" button clicked: This will delete ALL locally stored OTK thread data (threads, messages, and color associations) and then fetch everything fresh from 4chan. The viewer will effectively be reset and reloaded with the new data.');
    btnClearRefresh.disabled = true;
    // isManualRefreshInProgress will be set by clearAndRefresh itself.
    try {
        await clearAndRefresh();
    } catch (error) {
        console.error("Error directly from btnClearRefresh event:", error);
    } finally {
        btnClearRefresh.disabled = false;
    }
});

    // Initial render
    renderThreadList();

function startBackgroundRefresh() {
    if (backgroundRefreshIntervalId) {
        clearInterval(backgroundRefreshIntervalId);
    }
    backgroundRefreshIntervalId = setInterval(backgroundRefreshThreadsAndMessages, BACKGROUND_REFRESH_INTERVAL);
    console.log(`[OTK Tracker] Background refresh scheduled every ${BACKGROUND_REFRESH_INTERVAL / 1000} seconds.`);
}

// At the end of the script, after the initial renderThreadList();
startBackgroundRefresh(); // Add this call

})();