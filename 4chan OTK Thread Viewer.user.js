// ==UserScript==
// @name         4chan OTK Thread Viewer
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Viewer for OTK tracked threads messages with recursive quoted messages and toggle support
// @match        https://boards.4chan.org/b/
// @grant        none
// ==/UserScript==

(function () {
    'use strict';
    console.log('[OTK Viewer EXECUTION] Script starting to execute.');

    // let twitterWidgetsLoaded = false; // REMOVED - No longer using Twitter widgets.js
    // let twitterWidgetsLoading = false; // REMOVED
    let embedObserver = null;
    let isFirstRunAfterPageLoad = true;

    let originalBodyOverflow = '';
    let otherBodyNodes = [];
    let isManualViewerRefreshInProgress = false;
    let lastKnownMessageIds = new Set();

    // ---> START OF MOVED BLOCK <---
    const DB_NAME = 'OTKMediaCacheDB';
    const DB_VERSION = 1;
    const STORE_NAME = 'mediaFilesStore';
    let dbPromise = null;

    function openDB() {
        if (dbPromise) {
            return dbPromise; // Return existing promise if already connecting/connected
        }
        dbPromise = new Promise((resolve, reject) => {
            console.log('[OTK Cache] Opening IndexedDB: ' + DB_NAME + ' version ' + DB_VERSION);
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                console.log('[OTK Cache] onupgradeneeded: Upgrading/creating database.');
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'url' });
                    console.log('[OTK Cache] Created object store: ' + STORE_NAME);
                    store.createIndex('timestampIdx', 'timestamp', { unique: false });
                    console.log('[OTK Cache] Created index: timestampIdx');
                }
            };

            request.onsuccess = (event) => {
                console.log('[OTK Cache] Database opened successfully.');
                resolve(event.target.result);
            };

            request.onerror = (event) => {
                console.error('[OTK Cache DEBUG] openDB request.onerror:', event.target.error); // DEBUG
                dbPromise = null; // Reset promise on error so next call can try again
                reject(event.target.error);
            };

            request.onblocked = (event) => {
                console.warn('[OTK Cache DEBUG] openDB request.onblocked. Please close other tabs using this database.', event); // DEBUG
                dbPromise = null; // Reset
                reject(new Error('IndexedDB open request blocked.'));
            };
        });
        return dbPromise;
    }

    async function getMedia(url) {
        try {
            const db = await openDB(); // This promise might reject if openDB had an error
            if (!db) { // Defensive check if openDB resolved with null/undefined somehow (shouldn't happen with current openDB)
                console.error('[OTK Cache DEBUG] getMedia: openDB() returned a falsy value, cannot proceed with transaction for URL:', url);
                return null; // Treat as cache miss
            }
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(STORE_NAME, 'readwrite'); // readwrite to update timestamp
                const store = transaction.objectStore(STORE_NAME);
                const request = store.get(url);

                request.onsuccess = (event) => {
                    const record = event.target.result;
                    if (record) {
                        console.log('[OTK Cache] getMedia: Found record for URL:', url);
                        // Update timestamp for LRU (Least Recently Used)
                        record.timestamp = Date.now();
                        const updateRequest = store.put(record);
                        updateRequest.onerror = (updErr) => {
                            console.error('[OTK Cache] getMedia: Error updating timestamp for URL:', url, updErr.target.error);
                            // Still resolve with the record, timestamp update is best-effort
                            resolve(record.blob);
                        };
                        updateRequest.onsuccess = () => {
                            console.log('[OTK Cache] getMedia: Timestamp updated for URL:', url);
                            resolve(record.blob);
                        };
                    } else {
                        console.log('[OTK Cache] getMedia: No record found for URL:', url);
                        resolve(null);
                    }
                };
                request.onerror = (event) => {
                    console.error('[OTK Cache] getMedia: Error getting record for URL:', url, event.target.error);
                    reject(event.target.error);
                };
                transaction.oncomplete = () => {
                    // console.log('[OTK Cache] getMedia: Transaction completed for URL:', url);
                };
                transaction.onerror = (event) => {
                    console.error('[OTK Cache] getMedia: Transaction error for URL:', url, event.target.error);
                    reject(event.target.error); // This might reject before request.onerror if transaction itself fails
                };
            });
        } catch (dbOpenError) { // This will catch if await openDB() rejected
            console.error('[OTK Cache DEBUG] getMedia: Failed to open DB or transaction error for URL:', url, dbOpenError);
            return null; // Or reject(dbOpenError)
        }
    }

    async function saveMedia(url, blob, filename = '', originalExt = '') {
        try {
            const db = await openDB();
            return new Promise((resolve, reject) => {
                if (!blob || blob.size === 0) {
                    console.warn('[OTK Cache] saveMedia: Blob is null or empty for URL:', url, '. Skipping save.');
                    return reject(new Error('Cannot save null or empty blob.'));
                }

                const transaction = db.transaction(STORE_NAME, 'readwrite');
                const store = transaction.objectStore(STORE_NAME);
                const mediaType = blob.type.startsWith('image/') ? 'image' : (blob.type.startsWith('video/') ? 'video' : 'other');

                const record = {
                    url: url,
                    blob: blob,
                    timestamp: Date.now(),
                    filename: filename,
                    originalExt: originalExt,
                    mediaType: mediaType,
                    size: blob.size
                };

                const request = store.put(record);

                request.onsuccess = () => {
                    console.log('[OTK Cache] saveMedia: Successfully saved/updated media for URL:', url, '(Size: ' + blob.size + ')');
                    resolve(true);
                };
                request.onerror = (event) => {
                    console.error('[OTK Cache] saveMedia: Error saving media for URL:', url, event.target.error);
                    if (event.target.error.name === 'QuotaExceededError') {
                        console.warn('[OTK Cache] QuotaExceededError! Need to implement cache eviction.');
                        // TODO: Implement cache eviction strategy here or trigger it.
                    }
                    reject(event.target.error);
                };
                 transaction.oncomplete = () => {
                    // console.log('[OTK Cache] saveMedia: Transaction completed for URL:', url);
                };
                transaction.onerror = (event) => {
                    console.error('[OTK Cache] saveMedia: Transaction error for URL:', url, event.target.error);
                    reject(event.target.error);
                };
            });
        } catch (dbOpenError) {
            console.error('[OTK Cache] saveMedia: Failed to open DB, cannot save media for URL:', url, dbOpenError);
            return false; // Or reject(dbOpenError)
        }
    }
    // ---> END OF MOVED BLOCK <---

    // Storage keys (must match tracker script)
    // const THREADS_KEY = 'otkActiveThreads'; // Already defined globally, ensure only one definition
    const MESSAGES_KEY = 'otkMessagesByThreadId';
    const COLORS_KEY = 'otkThreadColors';
    const SELECTED_MESSAGE_KEY = 'otkSelectedMessageId';
    // const PAGE_REFRESH_ANCHOR_STATE_KEY = 'otkPageRefreshAnchorState'; // Commented out for debugging
    // const ANCHORED_MESSAGE_LINE_RATIO = 0.0; // Commented out for debugging

    // Decode HTML entities utility
    function decodeEntities(encodedString) {
        const txt = document.createElement('textarea');
        txt.innerHTML = encodedString;
        return txt.value;
    }

    function showLoadingOverlay(message) {
        if (loadingOverlay) { // loadingOverlay is the DOM element
            loadingOverlay.textContent = message;
            loadingOverlay.style.setProperty('display', 'flex', 'important');
            loadingOverlay.style.opacity = '1';
            // Updated log to include the actual textContent property for verification
            console.log(`[OTK Loading] Overlay SHOWN with message: "${message}" (textContent: "${loadingOverlay.textContent}")`);
            void loadingOverlay.offsetHeight; // Force reflow
        } else {
            console.error("[OTK Loading] loadingOverlay element not found in showLoadingOverlay!");
        }
    }

    function hideLoadingOverlay() {
        if (loadingOverlay) {
            loadingOverlay.style.display = 'none';
            console.log('[OTK Loading] Overlay HIDDEN.');
        }
    }

    function handleIntersection(entries, observer) {
        entries.forEach(entry => {
            const placeholder = entry.target;
            const isLoaded = placeholder.dataset.loaded === 'true';
            const embedType = placeholder.dataset.embedType; // Moved up to be accessible for Twitter logic

            if (entry.isIntersecting) {
                if (!isLoaded) {
                    // Load iframe or direct video
                    // const embedType = placeholder.dataset.embedType; // Moved up
                    const videoId = placeholder.dataset.videoId;
                    const startTime = placeholder.dataset.startTime; // Will be undefined if not set

                    console.log(`[OTK Viewer IO] Loading embed for: ${embedType} - ${videoId}`);

                    if (embedType === 'streamable') {
                        const guessedMp4Url = `https://cf-files.streamable.com/temp/${videoId}.mp4`;
                        placeholder.innerHTML = '<div class="play-button-overlay" style="color: #ccc;">▶ Checking cache...</div>'; // Temporary loading indicator
                        placeholder.style.backgroundColor = '#2c2c2c'; // Ensure loading bg

                        getMedia(guessedMp4Url).then(cachedBlob => {
                            if (cachedBlob) {
                                const objectURL = URL.createObjectURL(cachedBlob);
                                const frameId = placeholder.closest('[id^="otk-frame-"]') ? placeholder.closest('[id^="otk-frame-"]').id : 'io_placeholder_context';
                                placeholder.innerHTML = createVideoElementHTML(objectURL, videoId, 'streamable', frameId);
                                placeholder.dataset.loaded = 'true';
                                placeholder.dataset.cached = 'true';
                                console.log(`[OTK Cache IO] Loaded Streamable ${videoId} from cache.`);
                                placeholder.style.height = 'auto';
                                placeholder.style.aspectRatio = '16 / 9'; // Keep aspect ratio for video
                                placeholder.style.backgroundColor = 'transparent'; // Clear loading bg
                            } else {
                                placeholder.innerHTML = '<div class="play-button-overlay" style="color: #ccc;">▶ Fetching video...</div>'; // Update loading indicator
                                fetch(guessedMp4Url)
                                    .then(response => {
                                        if (response.ok && response.headers.get('content-type')?.startsWith('video/')) {
                                            return response.blob();
                                        }
                                        throw new Error('Streamable direct MP4 fetch failed or not a video. Status: ' + response.status + ' URL: ' + guessedMp4Url);
                                    })
                                    .then(blob => {
                                        saveMedia(guessedMp4Url, blob, videoId + '.mp4', '.mp4');
                                        const objectURL = URL.createObjectURL(blob);
                                        const frameId = placeholder.closest('[id^="otk-frame-"]') ? placeholder.closest('[id^="otk-frame-"]').id : 'io_placeholder_context';
                                        placeholder.innerHTML = createVideoElementHTML(objectURL, videoId, 'streamable', frameId);
                                        placeholder.dataset.loaded = 'true';
                                        placeholder.dataset.cached = 'true'; // Mark as cached even if fetched now
                                        console.log(`[OTK Cache IO] Fetched, cached, and loaded Streamable ${videoId}.`);
                                        placeholder.style.height = 'auto';
                                        placeholder.style.aspectRatio = '16 / 9'; // Keep aspect ratio
                                        placeholder.style.backgroundColor = 'transparent';
                                    })
                                    .catch(err => {
                                        console.warn(`[OTK Cache IO] Streamable direct MP4 for ${videoId} failed: ${err.message}. Falling back to iframe.`);
                                        placeholder.innerHTML = getStreamableIframeHTML(videoId); // Fallback
                                        placeholder.dataset.loaded = 'true';
                                        placeholder.style.height = '360px'; // Fallback fixed height for iframe
                                        placeholder.style.aspectRatio = '';
                                        placeholder.style.backgroundColor = 'transparent'; // Clear loading bg
                                    });
                            }
                        }).catch(dbError => {
                            console.error(`[OTK Cache IO] IndexedDB error for Streamable ${videoId}: ${dbError.message}. Falling back to iframe.`);
                            placeholder.innerHTML = getStreamableIframeHTML(videoId); // Fallback
                            placeholder.dataset.loaded = 'true';
                            placeholder.style.height = '360px'; // Fallback fixed height
                            placeholder.style.aspectRatio = '';
                            placeholder.style.backgroundColor = 'transparent'; // Clear loading bg
                        });
                    } else if (embedType === 'youtube') {
                        const iframeHTML = getYouTubeIframeHTML(videoId, startTime ? parseInt(startTime, 10) : null);
                        placeholder.style.height = '';
                        placeholder.style.aspectRatio = '16 / 9';
                        // console.log(`[OTK Viewer IO] Ensured placeholder aspect-ratio 16/9 for ${embedType}: ${videoId}`);
                         if (iframeHTML) {
                            placeholder.innerHTML = iframeHTML;
                            placeholder.dataset.loaded = 'true';
                        }
                    } else if (embedType === 'twitch-clip' || embedType === 'twitch-vod') {
                        const iframeHTML = getTwitchIframeHTML(embedType === 'twitch-clip' ? 'clip' : 'video', videoId, startTime ? parseInt(startTime, 10) : null);
                        placeholder.style.height = '360px'; // Twitch iframes often need this
                        placeholder.style.aspectRatio = '';
                        // console.log(`[OTK Viewer IO] Set placeholder height to 360px for ${embedType}: ${videoId}`);
                         if (iframeHTML) {
                            placeholder.innerHTML = iframeHTML;
                            placeholder.dataset.loaded = 'true';
                        }
                    }
                    // The original common `if (iframeHTML)` block is removed as logic is now per-case.
                }
            } else { // Out of view
                if (isLoaded) {
                    if (embedType === 'twitter') { // Twitter-specific unloading logic
                        console.log(`[OTK Viewer IO] Unloading Tweet: ${placeholder.dataset.tweetId}`);
                        const innerContainer = placeholder.querySelector('.tweet-content-container');
                        if (innerContainer) {
                            // Restore the empty reserved space div
                            innerContainer.innerHTML = `<div class="tweet-reserved-space" style="height: 250px; width: 100%; background-color: #f9f9f9;"></div>`;
                        }
                        placeholder.dataset.loaded = 'false';
                        return; // Skip generic unload for Twitter
                    }
                    // Generic unload for other embeds
                    console.log(`[OTK Viewer IO] Unloading embed for: ${placeholder.dataset.embedType} - ${placeholder.dataset.videoId}`);
                    // const embedType = placeholder.dataset.embedType; // Already available
                    const videoId = placeholder.dataset.videoId;
                    let innerPlaceholderHTML = '<div class="play-button-overlay">▶</div>';
                    let specificClass = '';
                    let specificText = '';

                    // Restore visual cues for specific services
                    if (embedType === 'youtube') {
                        placeholder.style.backgroundImage = `url('https://i.ytimg.com/vi/${videoId}/mqdefault.jpg')`;
                        specificClass = 'youtube-placeholder';
                    } else if (embedType === 'twitch-clip' || embedType === 'twitch-vod') {
                        placeholder.style.backgroundImage = ''; // Clear any previous
                        specificClass = 'twitch-placeholder';
                        specificText = embedType === 'twitch-clip' ? 'Twitch Clip' : 'Twitch VOD';
                        innerPlaceholderHTML += `<span style="position:absolute; bottom:5px; font-size:10px; color:rgba(255,255,255,0.7);">${specificText}</span>`;
                    } else if (embedType === 'streamable') {
                        placeholder.style.backgroundImage = '';
                        specificClass = 'streamable-placeholder';
                        specificText = 'Streamable Video';
                        innerPlaceholderHTML += `<span style="position:absolute; bottom:5px; font-size:10px; color:rgba(255,255,255,0.7);">${specificText}</span>`;
                    }

                    // ---> ADD NEW LOGIC BELOW <---
                    placeholder.style.height = ''; // Reset fixed height
                    placeholder.style.aspectRatio = '16 / 9'; // Reset to default CSS aspect ratio
                    console.log(`[OTK Viewer IO] Reset placeholder style for ${embedType}: ${videoId} before unloading.`);
                    // ---> ADD NEW LOGIC ABOVE <---

                    placeholder.innerHTML = innerPlaceholderHTML; // Existing line
                    placeholder.dataset.loaded = 'false'; // Existing line
                    // Ensure correct placeholder class is there if it got removed (it shouldn't if we only change innerHTML)
                    if (specificClass && !placeholder.classList.contains(specificClass)) {
                        placeholder.classList.add(specificClass);
                    }
                }
            }

            // Twitter loading logic (handleIntersection)
            if (embedType === 'twitter') { // This is the old embed type for widgets.js
                // 'placeholder' is the 'tweet-content-container' div.
                // We need to find the 'twitter-widget-target' inside it.
                const widgetTarget = placeholder.querySelector('.twitter-widget-target');

                if (!widgetTarget) {
                    console.error('[OTK Viewer IO] Old Twitter placeholder has no .twitter-widget-target child.', placeholder);
                    return; // Skip this entry
                }
                 // This section is for the old twitter embed type, which we are phasing out.
                 // For now, we'll leave its existing logic, but it should become dead code
                 // once all tweet links are converted to 'custom-twitter' type.
                console.warn('[OTK Viewer IO] Encountered old data-embed-type="twitter". This should be phased out.');
                 if (entry.isIntersecting) {
                    if (!isLoaded) {
                        console.log(`[OTK Viewer IO] Attempting to load OLD Tweet Widget: ${placeholder.dataset.tweetId}`);
                        ensureTwitterWidgetsLoaded().then(() => {
                            createTweetWithTimeout(placeholder.dataset.tweetId, widgetTarget, {
                                theme: 'light', conversation: 'none', align: 'center', width: 500, dnt: true
                            }).then(tweetElement => {
                                if (tweetElement) { placeholder.dataset.loaded = 'true'; /* ... styles ... */ }
                                else { /* ... error/empty styles ... */ }
                            }).catch(() => { /* ... error styles ... */ });
                        }).catch(error => {
                            widgetTarget.innerHTML = `<div>Old widget script failed. <a href="${placeholder.dataset.originalUrl}" target="_blank">View</a></div>`;
                        });
                    }
                } else { // Out of view
                    if (isLoaded) {
                        console.log(`[OTK Viewer IO] Unloading OLD Tweet Widget: ${placeholder.dataset.tweetId}`);
                        widgetTarget.innerHTML = `<div style="height: 100px; background: #eee;">Old tweet unloaded</div>`;
                        placeholder.dataset.loaded = 'false';
                    }
                }
                return; // Handled old twitter type
            } else if (embedType === 'custom-twitter') {
                if (entry.isIntersecting) {
                    if (placeholder.dataset.loaded === 'false') { // Check our specific loaded flag
                        const tweetId = placeholder.dataset.tweetId;
                        const originalUrl = placeholder.dataset.originalUrl;
                        console.log(`[CustomTweet IO] Custom tweet ${tweetId} is intersecting. Loading.`);
                        // Call the new function to fetch and render data
                        fetchAndRenderCustomTweet(tweetId, originalUrl, placeholder)
                            .catch(err => { // fetchAndRenderCustomTweet handles its own internal errors by updating the placeholder
                                console.error(`[CustomTweet IO] fetchAndRenderCustomTweet promise rejected for ${tweetId}:`, err);
                                // Ensure placeholder is marked loaded even if the function's internal error display failed
                                placeholder.dataset.loaded = 'true';
                            });
                        // fetchAndRenderCustomTweet will set placeholder.dataset.loaded = 'true' internally
                    }
                } else {
                    // Out of view for custom-twitter
                    // We could clear the content to save memory, but it's fixed size.
                    // For now, do nothing on scroll out for simplicity, as it's not required.
                    // If we wanted to revert to "Loading..." state:
                    // if (placeholder.dataset.loaded === 'true') {
                    //     const loadingDiv = placeholder.querySelector('.custom-tweet-loading');
                    //     const contentTextDiv = placeholder.querySelector('.custom-tweet-text-content');
                    //     const mediaDiv = placeholder.querySelector('.custom-tweet-media');
                    //     if (contentTextDiv) contentTextDiv.innerHTML = '';
                    //     if (mediaDiv) mediaDiv.innerHTML = '';
                    //     if (loadingDiv) loadingDiv.style.display = 'flex';
                    //     placeholder.dataset.loaded = 'false'; // Allow re-load on next intersection
                    //     console.log(`[CustomTweet IO] Custom tweet ${placeholder.dataset.tweetId} scrolled out, reset to loading.`);
                    // }
                }
                return; // Handled custom-twitter type
            }
            // Existing logic for other embed types (youtube, streamable, etc.) continues here...
        });
    }

    function handlePlaceholderInteraction(event) {
        // Find the placeholder element, whether event target is placeholder or its child (like the play button text span)
        const placeholder = event.target.closest('.embed-placeholder');

        if (!placeholder || placeholder.dataset.loaded === 'true') {
            return; // Not a placeholder or already loaded
        }

        // Check for correct event type and key for keydown
        if (event.type === 'click' || (event.type === 'keydown' && (event.key === 'Enter' || event.key === ' '))) {
            if (event.type === 'keydown') {
                event.preventDefault(); // Prevent space from scrolling, enter from submitting form etc.
            }

            // Same loading logic as in IntersectionObserver's intersecting branch
            const embedType = placeholder.dataset.embedType;
            const videoId = placeholder.dataset.videoId;
            const startTime = placeholder.dataset.startTime;
            // let iframeHTML = ''; // iframeHTML will be handled per-case now
            console.log('[OTK Viewer UX] handlePlaceholderInteraction: Processing event for embedType: ' + embedType + ', videoId: ' + videoId + ', eventType: ' + event.type);
            console.log(`[OTK Viewer UX] Manually triggering load for: ${embedType} - ${videoId}`);

            if (embedType === 'streamable') {
                const guessedMp4Url = `https://cf-files.streamable.com/temp/${videoId}.mp4`;
                placeholder.innerHTML = '<div class="play-button-overlay" style="color: #ccc;">▶ Checking cache...</div>'; // Temp loading indicator
                placeholder.style.backgroundColor = '#2c2c2c'; // Ensure loading bg

                getMedia(guessedMp4Url).then(cachedBlob => {
                    if (cachedBlob) {
                        const objectURL = URL.createObjectURL(cachedBlob);
                        const frameId = placeholder.closest('[id^="otk-frame-"]') ? placeholder.closest('[id^="otk-frame-"]').id : 'interaction_placeholder_context';
                        placeholder.innerHTML = createVideoElementHTML(objectURL, videoId, 'streamable', frameId);
                        placeholder.dataset.loaded = 'true';
                        placeholder.dataset.cached = 'true';
                        console.log(`[OTK Cache UX] Loaded Streamable ${videoId} from cache.`);
                        placeholder.style.height = 'auto';
                        placeholder.style.aspectRatio = '16 / 9'; // Keep aspect ratio
                        placeholder.style.backgroundColor = 'transparent'; // Clear loading bg
                    } else {
                        placeholder.innerHTML = '<div class="play-button-overlay" style="color: #ccc;">▶ Fetching video...</div>';
                        fetch(guessedMp4Url)
                            .then(response => {
                                if (response.ok && response.headers.get('content-type')?.startsWith('video/')) {
                                    return response.blob();
                                }
                                throw new Error('Streamable direct MP4 fetch failed or not a video. Status: ' + response.status + ' URL: ' + guessedMp4Url);
                            })
                            .then(blob => {
                                saveMedia(guessedMp4Url, blob, videoId + '.mp4', '.mp4');
                                const objectURL = URL.createObjectURL(blob);
                                const frameId = placeholder.closest('[id^="otk-frame-"]') ? placeholder.closest('[id^="otk-frame-"]').id : 'interaction_placeholder_context';
                                placeholder.innerHTML = createVideoElementHTML(objectURL, videoId, 'streamable', frameId);
                                placeholder.dataset.loaded = 'true';
                                placeholder.dataset.cached = 'true'; // Mark as cached even if fetched now
                                console.log(`[OTK Cache UX] Fetched, cached, and loaded Streamable ${videoId}.`);
                                placeholder.style.height = 'auto';
                                placeholder.style.aspectRatio = '16 / 9'; // Keep aspect ratio
                                placeholder.style.backgroundColor = 'transparent';
                            })
                            .catch(err => {
                                console.warn(`[OTK Cache UX] Streamable direct MP4 for ${videoId} failed: ${err.message}. Falling back to iframe.`);
                                placeholder.innerHTML = getStreamableIframeHTML(videoId); // Fallback
                                placeholder.dataset.loaded = 'true';
                                placeholder.style.height = '360px'; // Fallback fixed height
                                placeholder.style.aspectRatio = '';
                                placeholder.style.backgroundColor = 'transparent';
                            });
                    }
                }).catch(dbError => {
                    console.error(`[OTK Cache UX] IndexedDB error for Streamable ${videoId}: ${dbError.message}. Falling back to iframe.`);
                    placeholder.innerHTML = getStreamableIframeHTML(videoId); // Fallback
                    placeholder.dataset.loaded = 'true';
                    placeholder.style.height = '360px'; // Fallback fixed height
                    placeholder.style.aspectRatio = '';
                    placeholder.style.backgroundColor = 'transparent';
                });
                event.stopPropagation(); // Stop propagation for Streamable as it's handled
                // console.log('[OTK Viewer UX] Stopped event propagation after manual load attempt for ' + embedType + ': ' + videoId);
            } else if (embedType === 'youtube') {
                const iframeHTML = getYouTubeIframeHTML(videoId, startTime ? parseInt(startTime, 10) : null);
                placeholder.style.height = '';
                placeholder.style.aspectRatio = '16 / 9';
                // console.log(`[OTK Viewer UX] Ensured placeholder aspect-ratio 16/9 for manually loaded ${embedType}: ${videoId}`);
                if (iframeHTML) {
                    placeholder.innerHTML = iframeHTML;
                    placeholder.dataset.loaded = 'true';
                    event.stopPropagation();
                    // console.log('[OTK Viewer UX] Stopped event propagation after manual load for ' + embedType + ': ' + videoId);
                }
            } else if (embedType === 'twitch-clip' || embedType === 'twitch-vod') {
                const iframeHTML = getTwitchIframeHTML(embedType === 'twitch-clip' ? 'clip' : 'video', videoId, startTime ? parseInt(startTime, 10) : null);
                placeholder.style.height = '360px'; // Twitch iframes often need this
                placeholder.style.aspectRatio = '';
                // console.log(`[OTK Viewer UX] Set placeholder height to 360px for manually loaded ${embedType}: ${videoId}`);
                if (iframeHTML) {
                    placeholder.innerHTML = iframeHTML;
                    placeholder.dataset.loaded = 'true';
                    event.stopPropagation();
                    // console.log('[OTK Viewer UX] Stopped event propagation after manual load for ' + embedType + ': ' + videoId);
                }
            }
            // The original common `if (iframeHTML)` block is removed as logic is now per-case.
        }
    }

    // REMOVED: ensureTwitterWidgetsLoaded, createTweetWithTimeout, processTweetEmbeds, createTwitterEmbedPlaceholder (old one)
    // These were all related to the Twitter widgets.js approach.

    // Helper function to create YouTube embed HTML
    function getYouTubeIframeHTML(videoId, startTimeSeconds) {
        let finalSrc = `https://www.youtube.com/embed/${videoId}`;
        if (startTimeSeconds && startTimeSeconds > 0) {
            finalSrc += `?start=${startTimeSeconds}`;
        }
        const iframeHtml = `<iframe width="560" height="315" src="${finalSrc}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen style="aspect-ratio: 16 / 9; width: 100%; max-width: 560px;"></iframe>`;
        return `<div style="display: block; margin-top: 5px; margin-bottom: 5px;">${iframeHtml}</div>`;
    }

    // Helper function to create Rumble link HTML (updated from embed)
    function createRumbleEmbed(rumbleIdWithV, originalUrl) {
        let displayText;
        // Try to get a more descriptive title from the path part of the URL
        const urlPathMatch = originalUrl.match(/rumble\.com\/(?:v[a-zA-Z0-9]+-)?([a-zA-Z0-9_-]+)(?:\.html|$|\?)/);
        if (urlPathMatch && urlPathMatch[1] && urlPathMatch[1].toLowerCase() !== 'embed') {
            // Capitalize first letter and replace hyphens/underscores with spaces
            let titleCandidate = urlPathMatch[1].replace(/[-_]/g, ' ');
            titleCandidate = titleCandidate.charAt(0).toUpperCase() + titleCandidate.slice(1);
            displayText = `View on Rumble: ${titleCandidate}`;
        } else {
            // Fallback display text if path parsing doesn't yield a good title
            displayText = `View on Rumble (Clip ID: ${rumbleIdWithV})`;
        }
        const escapedUrl = originalUrl.replace(/"/g, '&quot;');
        return `<a href="${escapedUrl}" target="_blank" rel="noopener noreferrer" style="display: block; padding: 10px; border: 1px solid #ccc; border-radius: 10px; text-decoration: none; color: #85c742; background-color: #f0f0f0;">${displayText} <img src="https://rumble.com/favicon.ico" style="width:16px; height:16px; vertical-align:middle; border:none;"></a>`;
    }

    // Helper function to format seconds to Twitch's hms time format
    function formatSecondsToTwitchTime(totalSeconds) {
        if (totalSeconds === null || totalSeconds === undefined || totalSeconds <= 0) {
            return null;
        }
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = Math.floor(totalSeconds % 60); // Ensure seconds is integer
        return `${String(hours).padStart(2, '0')}h${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`;
    }

    // Helper function to create Twitch embed HTML
    function getTwitchIframeHTML(type, id, startTimeSeconds) { // Added startTimeSeconds
        const parentHostname = 'boards.4chan.org';
        let src = '';
        if (type === 'clip') {
            src = `https://clips.twitch.tv/embed?clip=${id}&parent=${parentHostname}&autoplay=false`;
        } else if (type === 'video') {
            src = `https://player.twitch.tv/?video=${id}&parent=${parentHostname}&autoplay=false`;
            const formattedTime = formatSecondsToTwitchTime(startTimeSeconds);
            if (formattedTime) {
                src += `&t=${formattedTime}`;
            }
        }
        const iframeHtml = `<iframe src="${src}" style="width: 100%; min-height: 360px; aspect-ratio: 16 / 9; max-width: 640px; border: none;" allowfullscreen scrolling="no"></iframe>`;
        return `<div style="display: block; margin-top: 5px; margin-bottom: 5px;">${iframeHtml}</div>`;
    }

    // Helper function to create Streamable embed HTML
    function getStreamableIframeHTML(videoId) {
        const iframeHtml = `<iframe src="https://streamable.com/e/${videoId}?loop=false" style="width: 100%; min-height: 360px; aspect-ratio: 16 / 9; max-width: 640px; border: none;" allowfullscreen></iframe>`;
        return `<div style="display: block; margin-top: 5px; margin-bottom: 5px;">${iframeHtml}</div>`;
    }

function createVideoElementHTML(blobUrl, videoId, type, parentFrameId) { // Added parentFrameId
    const loopAttribute = (type === 'streamable') ? 'loop="false"' : ''; // Add loop="false" for streamable
    // Using String(blobUrl) in case blobUrl is not a string, and substring(0,80) to keep log concise
    console.log('[OTK Video Debug] createVideoElementHTML called for videoId:', videoId, 'type:', type, 'in frame:', (parentFrameId || 'unknown_placeholder_frame'), 'BlobURL:', String(blobUrl).substring(0, 80));
    // console.log(`[OTK Cache] Creating direct video element for ${type} ID ${videoId} with blob URL.`); // Original log replaced
    return `<video src="${blobUrl}" controls autoplay="false" ${loopAttribute} style="width: 100%; min-height: 360px; aspect-ratio: 16 / 9; max-width: 640px; border: none; margin: 8px 0; display: block; background-color: #000;"></video>`;
}

    // Helper functions for YouTube time parsing
    function parseTimeParam(timeString) {
        if (!timeString) return null;
        let totalSeconds = 0;
        if (/^\d+$/.test(timeString)) {
            totalSeconds = parseInt(timeString, 10);
        } else {
            const hoursMatch = timeString.match(/(\d+)h/);
            if (hoursMatch) totalSeconds += parseInt(hoursMatch[1], 10) * 3600;
            const minutesMatch = timeString.match(/(\d+)m/);
            if (minutesMatch) totalSeconds += parseInt(minutesMatch[1], 10) * 60;
            const secondsMatch = timeString.match(/(\d+)s/);
            if (secondsMatch) totalSeconds += parseInt(secondsMatch[1], 10);
        }
        return totalSeconds > 0 ? totalSeconds : null;
    }

    function getTimeFromParams(allParamsString) {
        if (!allParamsString) return null;
        // Matches t=VALUE or start=VALUE from the param string
        const timeMatch = allParamsString.match(/[?&](?:t|start)=([^&]+)/);
        if (timeMatch && timeMatch[1]) {
            return parseTimeParam(timeMatch[1]);
        }
        return null;
    }

   function debounce(func, delay) {
       let timeout;
       return function(...args) {
           const context = this;
           clearTimeout(timeout);
           timeout = setTimeout(() => func.apply(context, args), delay);
       };
   }

   async function scrollToMessageById(messageId, blockAlign = 'center', isExplicitSelection = false) {
       const MAX_RETRIES = 5; // Max number of attempts to find the element
       const RETRY_DELAY_MS = 750; // Delay between retry attempts

       for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
           const element = viewer.querySelector('div[data-message-id="' + messageId + '"]');
           if (element) {
               if (isExplicitSelection) {
                   const previouslySelected = viewer.querySelector('.selected-message');
                   if (previouslySelected && previouslySelected !== element) { // Avoid removing class from element itself if re-selecting
                       previouslySelected.classList.remove('selected-message');
                   }
                   element.classList.add('selected-message');
               }
               console.log('[OTK Viewer Scroll] scrollToMessageById: Found element for ID ' + messageId + ' on attempt ' + attempt + '. Will scroll with align: ' + blockAlign + '.');

               // The actual scroll is still delayed slightly after finding
               setTimeout(() => {
                   console.log('[OTK Viewer Scroll] scrollToMessageById: Scrolling to element for ID ' + messageId + ' after action delay.');
                   element.scrollIntoView({ behavior: 'auto', block: blockAlign });
               }, 250); // Keep this short delay for the scroll action itself
               return true; // Element found, scroll initiated (or will be shortly)
           } else {
               console.log('[OTK Viewer Scroll] scrollToMessageById: Element NOT FOUND for ID ' + messageId + ' on attempt ' + attempt + '/' + MAX_RETRIES + '.');
               if (attempt < MAX_RETRIES) {
                   console.log('[OTK Viewer Scroll] Retrying find for ID ' + messageId + ' in ' + RETRY_DELAY_MS + 'ms...');
                   await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
               }
           }
       }

    // This log line below was the original final log before 'return false'
    // console.log(`[OTK Viewer Scroll] scrollToMessageById: Element NOT FOUND for ID \${messageId} after all \${MAX_RETRIES} attempts.`);
    // We'll make it part of the new diagnostic block for clarity.

    // New diagnostic block:
    console.log('[OTK Viewer Diagnostics] scrollToMessageById: FINAL FAILURE to find ID ' + messageId + ' after ' + MAX_RETRIES + ' attempts.');
    if (viewer) { // Check if viewer itself exists
        console.log('    - viewer.isConnected: ' + viewer.isConnected);
        console.log('    - viewer.children.length (direct children): ' + viewer.children.length);
        const currentMessagesInDOM = viewer.querySelectorAll('div[data-message-id]');
        console.log('    - found elements with data-message-id: ' + currentMessagesInDOM.length);

        if (currentMessagesInDOM.length === 0 && viewer.children.length > 0) {
            // If no data-message-id divs found but viewer has children, log snippet
            console.log('    - viewer.innerHTML snippet (start): ' + viewer.innerHTML.substring(0, 2000));
            console.log('    - viewer.innerHTML snippet (end): ' + viewer.innerHTML.substring(Math.max(0, viewer.innerHTML.length - 2000)));
        } else if (currentMessagesInDOM.length > 0 && currentMessagesInDOM.length < 15) {
            // If some messages are found but not many, log their IDs
            let ids = [];
            currentMessagesInDOM.forEach(el => ids.push(el.dataset.messageId));
            console.log('    - IDs found in DOM: [' + ids.join(', ') + ']');
            // Check if the target ID is among them but perhaps under a different query
            if (!ids.includes(messageId)) {
                 console.log('    - Target ID ' + messageId + ' is NOT among these found IDs.');
            }
        } else if (currentMessagesInDOM.length === 0 && viewer.children.length === 0) {
            console.log('    - viewer appears to be completely empty.');
        }
    } else {
        console.log('    - CRITICAL: viewer element itself is null or undefined at this point!');
    }

       return false; // Element not found after all retries
   }

   function getTopMostVisibleMessageInfo(viewerElement) {
    if (!viewerElement || viewerElement.style.display === 'none' || !viewerElement.children.length) {
        return null;
    }
    const viewerRectTop = viewerElement.getBoundingClientRect().top;
    const messages = viewerElement.querySelectorAll('div[data-message-id]');
    for (let i = 0; i < messages.length; i++) {
        const msgElement = messages[i];
        const msgElementRect = msgElement.getBoundingClientRect();
        if (msgElementRect.bottom > viewerRectTop && msgElementRect.top < viewerElement.getBoundingClientRect().bottom) { //Ensure it's actually in viewport
            return {
                messageId: msgElement.dataset.messageId,
                scrollTop: viewerElement.scrollTop // Current scroll position of the viewer
            };
        }
    }
    // Fallback if no message is strictly at the top but viewer is scrolled
    if (messages.length > 0 && viewerElement.scrollTop > 0) {
        // Find message closest to current scrollTop - more complex, for now, above is primary
    }
    return null; // Or return first message if any other heuristic fails
   }

function captureLineAnchoredScrollState() {
    /* Entire body commented for debugging */
    return null;
}

async function restoreLineAnchoredScrollState(state) {
    /* Entire body commented for debugging */
    return false;
}

async function manageInitialScroll() {
    // isFirstRunAfterPageLoad logic can be removed if not strictly needed by other parts,
    // or kept if it serves a purpose beyond scroll. For this refactor, let's assume it's not essential for scroll.
    if (isFirstRunAfterPageLoad) { // Keep isFirstRunAfterPageLoad for now as it might be used elsewhere or for future logic
        console.log('[OTK Viewer LIFECYCLE] manageInitialScroll: First run after page load. Flag will be cleared.');
        isFirstRunAfterPageLoad = false; // Clear the flag
    }
    console.log('[OTK Scroll] manageInitialScroll: Entered');
    let scrollRestored = false;

    // 1. Try Line Anchored Scroll Restoration (for F5 refresh)
    // const savedStateJSON = localStorage.getItem(PAGE_REFRESH_ANCHOR_STATE_KEY);
    // if (savedStateJSON) {
    //     console.log('[OTK Scroll Lines] Found saved anchor state for F5 refresh:', savedStateJSON);
    //     try {
    //         const savedState = JSON.parse(savedStateJSON);
    //         if (savedState) {
    //             console.log('[OTK Scroll Lines] Attempting to restore F5 scroll using line anchored state:', savedState);
    //             if (await restoreLineAnchoredScrollState(savedState)) {
    //                 scrollRestored = true;
    //                 console.log('[OTK Scroll Lines] Successfully restored F5 scroll using line anchored state.');
    //             } else {
    //                 console.warn('[OTK Scroll Lines] Failed to restore F5 scroll using line anchored state.');
    //             }
    //         }
    //     } catch (e) {
    //         console.error('[OTK Scroll Lines] Error parsing saved anchor state JSON:', e);
    //     }
    //     localStorage.removeItem(PAGE_REFRESH_ANCHOR_STATE_KEY);
    // }

    // 2. Try Explicit Selection (SELECTED_MESSAGE_KEY from localStorage) if F5 anchor restore didn't happen or failed
    if (!scrollRestored) {
        const explicitSelectionId = localStorage.getItem(SELECTED_MESSAGE_KEY);
        if (explicitSelectionId) {
            console.log('[OTK Viewer Scroll] manageInitialScroll: Attempting to restore explicit selection:', explicitSelectionId);
            if (await scrollToMessageById(explicitSelectionId, 'center', true)) { // true for isExplicitSelection
                // hideLoadingOverlay(); // hideLoadingOverlay is currently a no-op
                // viewer.style.display = 'block'; // This logic is now at the end
                console.log('[OTK Viewer] Explicit selection restored.'); // Simpler log for now
                scrollRestored = true; // Mark as restored
                // Explicit selection will also fall through to the final hide/show logic
            } else {
                 console.log('[OTK Scroll] Explicit selection restore failed: message not found.');
            }
        }
    }

    // 3. Fallback: Scroll to Newest Message (if no other scroll method worked)
    if (!scrollRestored) { // This condition is key: only if F5 anchor failed AND explicit selection was not found/failed.
        console.log('[OTK Viewer Scroll] manageInitialScroll: No specific scroll target found or restored by anchor/selection, scrolling to newest message.');
        if (viewer.children.length > 0) {
        const lastMessageElement = viewer.lastElementChild;
        if (lastMessageElement && typeof lastMessageElement.scrollIntoView === 'function') {
            // Adding a small delay as was present in some earlier versions, helps ensure layout before scroll
            await new Promise(resolve => setTimeout(resolve, 50));
            lastMessageElement.scrollIntoView({ behavior: 'auto', block: 'end' });
            console.log('[OTK Viewer Scroll] Scrolled to last message (fallback).');
        }
    }
    }

    // 4. Final action: Ensure viewer is visible and then hide loading overlay.
    if (viewer) { // Ensure viewer exists before trying to show it
        viewer.style.display = 'block';
        console.log('[OTK Viewer] Main viewer display set to block after loading and scroll in manageInitialScroll.');
    } else {
        console.error('[OTK Viewer] CRITICAL: Viewer element not found at end of manageInitialScroll when trying to make it visible!');
    }

    showLoadingOverlay("Finalizing view and scroll position..."); // Restored
    // console.log('[OTK Loading] All scroll and content processing complete in manageInitialScroll. Adding SIGNIFICANT delay before hiding overlay.'); // Original log for this section
    await new Promise(r => setTimeout(r, 1000)); // INCREASED DELAY

    // This should be the VERY LAST action.
    // if (loadingOverlay) loadingOverlay.style.display = 'none';  // Removed direct manipulation
    hideLoadingOverlay(); // Restored helper call

    console.log('[OTK Viewer LIFECYCLE] manageInitialScroll: Processing complete, overlay hidden.');
}

    // Convert >>123456 to link text "123456" with class 'quote'
    // We'll link to the message number in viewer and use it for quote expansion
    // Also handles YouTube, X/Twitter, Rumble, Twitch, Streamable, and general links.
    function convertQuotes(text, embedCounts) {
        // Unescape HTML entities first
        text = decodeEntities(text);

        // Define regexes (ensure global flag 'g' is used)
        const youtubeRegexG = /https?:\/\/(?:www\.youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)((?:[?&][a-zA-Z0-9_=&%.:+-]*)*)/g;
        // Twitter regex:
        // - Group 1: Full URL (e.g. https://x.com/user/status/123)
        // - Group 2: Tweet ID (e.g. 123)
        // - Negative lookbehind (?<!(?:href="|src="|=)) to avoid matching URLs already likely part of HTML attributes.
        // - \b for word boundary.
        const twitterRegexG = /(?<!(?:href="|src="|=))\b(https?:\/\/(?:twitter\.com|x\.com)\/[a-zA-Z0-9_]+\/status\/([0-9]+))(?:\?[^\s<'"`]*)?/g;
        const rumbleRegexG = /https?:\/\/rumble\.com\/(?:embed\/)?(v[a-zA-Z0-9]+)(?:-[^\s"'>?&.]*)?(?:\.html)?(?:\?[^\s"'>]*)?/g;
        const twitchClipRegexG = /https?:\/\/(?:clips\.twitch\.tv\/|(?:www\.)?twitch\.tv\/[a-zA-Z0-9_]+\/clip\/)([a-zA-Z0-9_-]+)(?:\?[^\s"'>]*)?/g;
        const twitchVodRegexG = /https?:\/\/(?:www\.)?twitch\.tv\/videos\/([0-9]+)((?:[?&][a-zA-Z0-9_=&%.:+-]*)*)/g;
        const streamableRegexG = /https?:\/\/streamable\.com\/([a-zA-Z0-9]+)(?:\?[^\s"'>]*)?/g;
        const generalLinkRegexG = /(?<!(?:href="|src="))https?:\/\/[^\s<>"']+[^\s<>"'.?!,:;)]/g;
        const quoteLinkRegexG = /&gt;&gt;(\d+)/g;

        // Order of operations:

        // 1. X/Twitter - Convert to custom tweet placeholder HTML
        // This regex will find all Twitter status URLs not already in an attribute.
        text = text.replace(twitterRegexG, (match, originalUrl, tweetId) => {
            console.log(`[OTK ConvertQuotes] Found Twitter URL: ${originalUrl}, Tweet ID: ${tweetId}. Creating custom placeholder.`);
            if (embedCounts && embedCounts.hasOwnProperty('twitter')) embedCounts.twitter++; // Count custom tweets
            return createCustomTweetPlaceholderHTML(tweetId, originalUrl);
        });
        // The old __FULL_TWITTER_EMBED__ marker logic is no longer needed as all tweets go through the custom flow.

        // 2. YouTube
        text = text.replace(youtubeRegexG, (match, videoId, allParams) => {
            const startTime = getTimeFromParams(allParams);
            return `__YOUTUBE_EMBED__[${videoId}]__[${startTime || ''}]__`;
        });

        // 3. Rumble
        text = text.replace(rumbleRegexG, (match, rumbleIdWithV) => {
            const hiddenUrl = match.replace(/^https?:\/\//, "RUMBLE_URL_SCHEME_PLACEHOLDER://"); // 'match' is the full original URL
            return `__RUMBLE_EMBED__[${rumbleIdWithV}]__LINK:${hiddenUrl}__`;
        });

        // 4. Twitch Clips
        text = text.replace(twitchClipRegexG, (match, clipId) => `__TWITCH_CLIP_EMBED__[${clipId}]__`);

        // 5. Twitch VODs
        text = text.replace(twitchVodRegexG, (match, vodId, allParams) => {
            const startTime = getTimeFromParams(allParams); // getTimeFromParams returns total seconds or null
            return `__TWITCH_VOD_EMBED__[${vodId}]__[${startTime || ''}]__`;
        });

        // 6. Streamable
        text = text.replace(streamableRegexG, (match, videoId) => `__STREAMABLE_EMBED__[${videoId}]__`);

        // 7. General links (must come after specific platform placeholders)
        text = text.replace(generalLinkRegexG, (match) => {
            // Avoid re-processing placeholders for YouTube, Twitter, Rumble, Twitch or Streamable
            if (match.includes("__YOUTUBE_EMBED__") || match.includes("__TWITTER_EMBED__") || match.includes("__RUMBLE_EMBED__") || match.includes("__TWITCH_CLIP_EMBED__") || match.includes("__TWITCH_VOD_EMBED__") || match.includes("__STREAMABLE_EMBED__")) {
                return match;
            }
            return `<a href="${match}" target="_blank" rel="noopener noreferrer">${match}</a>`;
        });

        // 8. >>123 style quotes
        text = text.replace(quoteLinkRegexG, (match, p1) => `<a href="#" class="quote" data-postid="${p1}">${p1}</a>`);

        // Final placeholder replacements:
        // 9. YouTube embeds
        text = text.replace(/__YOUTUBE_EMBED__\[([a-zA-Z0-9_-]+)\]__\[([0-9]*)\]__/g, (match, videoId, startTime) => {
            if (embedCounts && embedCounts.hasOwnProperty('youtube')) embedCounts.youtube++;
            const thumbUrl = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
            let attributes = `class="embed-placeholder youtube-placeholder" data-embed-type="youtube" data-video-id="${videoId}" data-loaded="false" tabindex="0"`;
            if (startTime) attributes += ` data-start-time="${startTime}"`;
            return `<div ${attributes} style="background-image: url('${thumbUrl}');">
                    <div class="play-button-overlay">▶</div>
                </div>`;
        });

        // 10. X/Twitter embeds/links
        text = text.replace(/__FULL_TWITTER_EMBED__\[([0-9]+)\]__LINK:(.*?)__/g, (match, tweetId, hiddenUrlFromPlaceholder) => {
            const originalUrl = hiddenUrlFromPlaceholder.replace(/^https?:\/\//, "https://"); // Ensure it's a full URL for createTwitterEmbedPlaceholder
            console.log(`[OTK ConvertQuotes] Processing __FULL_TWITTER_EMBED__ for Tweet ID: ${tweetId}, URL: ${originalUrl}`);
            // createTwitterEmbedPlaceholder returns a DOM element. We need its outerHTML to inject it into the string.
            // However, convertQuotes is expected to return an HTML string.
            // The marker approach in appendNewMessages/renderAllMessages should be followed by a DOM manipulation step.
            // For now, let's return the DOM element's string representation and see how it integrates.
            // This is a temporary step; the plan is to call processAndReplaceTweetMarkers or similar *after* innerHTML is set.
            // UPDATE: createTwitterEmbedPlaceholder now returns a DOM element.
            // The calling function (renderMessageWithQuotes) will need to handle this.
            // Let's adjust convertQuotes to return a specific marker that renderMessageWithQuotes can replace with the DOM element.
            // OR, even better, the functions `appendNewMessagesToFrame` and `renderAllMessages` should identify tweets,
            // then call `renderMessageWithQuotes`, and then *after* `contentDiv.innerHTML = convertQuotes(...)`
            // they should scan `contentDiv` for these `__FULL_TWITTER_EMBED__` markers and replace them with the DOM element from `createTwitterEmbedPlaceholder`.

            // Revising: The `__FULL_TWITTER_EMBED__` marker is set by the *caller* of `renderMessageWithQuotes`.
            // `convertQuotes` itself should process this marker if found.
            const placeholderElement = createTwitterEmbedPlaceholder(tweetId, originalUrl);
            return placeholderElement.outerHTML; // This injects the HTML string of the placeholder.
        });
        // The old `processAndReplaceTweetMarkers` is removed, direct replacement via `load-tweet-link` click or this full embed.


        // 11. Rumble embeds
        text = text.replace(/__RUMBLE_EMBED__\[(v[a-zA-Z0-9]+)\]__LINK:(.*?)__/g, (match, rumbleIdWithV, hiddenUrlFromPlaceholder) => {
            const originalUrl = hiddenUrlFromPlaceholder.replace(/^RUMBLE_URL_SCHEME_PLACEHOLDER:\/\//, "https://");
            return createRumbleEmbed(rumbleIdWithV, originalUrl);
        });

        // 12. Twitch Clip embeds
        text = text.replace(/__TWITCH_CLIP_EMBED__\[([a-zA-Z0-9_-]+)\]__/g, (match, clipId) => {
            if (embedCounts && embedCounts.hasOwnProperty('twitch')) embedCounts.twitch++;
            // No easily accessible thumbnail for clips without API, use generic placeholder
            return `<div class="embed-placeholder twitch-placeholder" data-embed-type="twitch-clip" data-video-id="${clipId}" data-loaded="false" tabindex="0">
                    <div class="play-button-overlay">▶</div>
                    <span style="position:absolute; bottom:5px; font-size:10px; color:rgba(255,255,255,0.7);">Twitch Clip</span>
                </div>`;
        }); // Clips don't use startTimeSeconds from URL like VODs

        // 13. Twitch VOD embeds
        text = text.replace(/__TWITCH_VOD_EMBED__\[([0-9]+)\]__\[([0-9]*)\]__/g, (match, vodId, startTime) => {
            if (embedCounts && embedCounts.hasOwnProperty('twitch')) embedCounts.twitch++;
            let attributes = `class="embed-placeholder twitch-placeholder" data-embed-type="twitch-vod" data-video-id="${vodId}" data-loaded="false" tabindex="0"`;
            if (startTime) attributes += ` data-start-time="${startTime}"`;
            // No easily accessible thumbnail for VODs without API
            return `<div ${attributes}>
                    <div class="play-button-overlay">▶</div>
                    <span style="position:absolute; bottom:5px; font-size:10px; color:rgba(255,255,255,0.7);">Twitch VOD</span>
                </div>`;
        });

        // 14. Streamable embeds
        text = text.replace(/__STREAMABLE_EMBED__\[([a-zA-Z0-9]+)\]__/g, (match, videoId) => {
            if (embedCounts && embedCounts.hasOwnProperty('streamable')) embedCounts.streamable++;
            // No easily accessible thumbnail for Streamable without API
            return `<div class="embed-placeholder streamable-placeholder" data-embed-type="streamable" data-video-id="${videoId}" data-loaded="false" tabindex="0">
                    <div class="play-button-overlay">▶</div>
                    <span style="position:absolute; bottom:5px; font-size:10px; color:rgba(255,255,255,0.7);">Streamable Video</span>
                </div>`;
        });

        return text;
    }

    // Load storage data
    let activeThreads = JSON.parse(localStorage.getItem(THREADS_KEY)) || [];
    let messagesByThreadId = JSON.parse(localStorage.getItem(MESSAGES_KEY)) || {};
    try {
        const threadIds = Object.keys(messagesByThreadId);
        let totalMessages = 0;
        threadIds.forEach(tid => {
            totalMessages += (messagesByThreadId[tid] || []).length;
        });
        console.log('[OTK Viewer Metrics] Loaded messagesByThreadId:');
        console.log(`    - Thread count: ${threadIds.length}`);
        console.log(`    - Total messages stored: ${totalMessages}`);
        console.log(`    - Estimated size (JSON string length): ${JSON.stringify(messagesByThreadId).length} characters`);
    } catch (e) {
        console.error('[OTK Viewer Metrics] Error calculating messagesByThreadId stats:', e);
    }
    let threadColors = JSON.parse(localStorage.getItem(COLORS_KEY)) || {};

    // Create or get viewer container
    let viewer = document.getElementById('otk-thread-viewer');
    if (!viewer) {
        viewer = document.createElement('div');
        viewer.id = 'otk-thread-viewer';
        viewer.style.cssText = `
            position: fixed;
            top: 0;
            left: 0; right: 0; bottom: 0;
            background: #fff4de;
            overflow-y: auto;
            padding: 10px 20px;
            font-family: Verdana, sans-serif;
            font-size: 14px;
            z-index: 9998; /* Keep below tracker bar if tracker bar is to remain visible */
            display: none; /* start hidden */
        `;
        document.body.appendChild(viewer);
    }

    let loadingOverlay = document.getElementById('otk-loading-overlay');
    if (!loadingOverlay) {
        loadingOverlay = document.createElement('div');
        loadingOverlay.id = 'otk-loading-overlay';
        loadingOverlay.textContent = 'Loading OTK Viewer...'; // Or similar text
        loadingOverlay.style.cssText = `
            position: fixed;
            top: 0; left: 0; width: 100%; height: 100%;
            background-color: rgba(20, 20, 20, 0.85); /* Darker semi-transparent background */
            color: #f0f0f0; /* Light text color */
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px; /* Adjusted font size */
            font-family: Verdana, sans-serif; /* Consistent font */
            z-index: 10001; /* Higher than viewer content, potentially below a global close button if one existed */
            display: none; /* Initially hidden */
        `;
        document.body.appendChild(loadingOverlay);
    }

    // Inject CSS for selected messages
    if (!document.getElementById('otk-viewer-styles')) {
        const styleSheet = document.createElement("style");
        styleSheet.id = 'otk-viewer-styles';
        styleSheet.type = "text/css";
        styleSheet.innerText = `
            .selected-message {
                background-color: #E0E0E0 !important;
                box-shadow: 0 0 5px rgba(0,0,0,0.3) !important;
            }
.embed-placeholder { /* General placeholder for YouTube, Twitch, etc. */
    position: relative;
    width: 100%;
    max-width: 560px; 
    aspect-ratio: 16 / 9; 
    background-color: #2c2c2c; 
    background-size: cover;
    background-position: center;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 8px 0; 
    border: 1px solid #444;
    color: white; 
    overflow: hidden; 
}
.embed-placeholder:focus, .embed-placeholder:hover {
    border-color: #888;
    outline: 2px solid #0078D4; 
}
.play-button-overlay {
    font-size: 40px;
    color: rgba(255, 255, 255, 0.9);
    background-color: rgba(0, 0, 0, 0.6);
    border-radius: 50%;
    width: 70px;
    height: 70px;
    display: flex;
    align-items: center;
    justify-content: center;
    text-shadow: 0 0 8px black;
    pointer-events: none; 
    border: 2px solid rgba(255, 255, 255, 0.5);
}
.embed-placeholder[data-loaded="true"] { 
    background-image: none !important;
    border-color: transparent; 
    padding: 0; 
}
.embed-placeholder[data-loaded="true"] .play-button-overlay {
    display: none;
}
.youtube-placeholder { }
.twitch-placeholder { background-color: #3a265c; }
.streamable-placeholder { background-color: #1c3d52; }

/* REMOVED Styles for the OLD Twitter embed container (twitter-tweet via widgets.js) */
/* .tweet-content-container.embed-placeholder[data-embed-type="twitter"] { ... } */
/* .tweet-content-container.embed-placeholder[data-embed-type="twitter"][data-loaded="true"] { ... } */

/* NEW Custom Tweet Styles */
.custom-tweet-placeholder {
    display: block; 
    width: 500px;    
    max-height: 300px; 
    border: 1px solid #ccc;
    border-radius: 8px;
    padding: 12px;
    margin: 10px auto; 
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.4;
    background-color: #fff;
    overflow: hidden; 
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    /* This will also need .embed-placeholder class if IntersectionObserver is to be used */
    /* data-embed-type will be 'custom-twitter' */
}

.custom-tweet-header {
    display: flex;
    align-items: flex-start; 
    margin-bottom: 8px;
}

.custom-tweet-avatar {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    margin-right: 10px;
    border: 1px solid #eee;
}

.custom-tweet-author {
    display: flex;
    flex-direction: column;
    justify-content: center; 
}

.custom-tweet-displayname {
    font-weight: bold;
    color: #14171a;
}

.custom-tweet-username {
    color: #657786;
    font-size: 0.9em;
}

.custom-tweet-content {
    max-height: 150px; 
    overflow-y: auto;  
    margin-bottom: 8px;
    color: #14171a;
    white-space: pre-wrap; 
    word-wrap: break-word;
}

.custom-tweet-content p { 
    margin: 0 0 10px 0;
}
.custom-tweet-content p:last-child {
    margin-bottom: 0;
}

.custom-tweet-media { /* Container for images/videos within the content area */
    margin-top: 8px;
}

.custom-tweet-media img,
.custom-tweet-media video {
    display: block; 
    max-width: 100%; 
    max-height: 120px; /* Max height for a single media item */
    border-radius: 8px;
    margin-top: 5px;
    object-fit: contain; 
}
/* If multiple images, they'd be stacked or need different styling */

.custom-tweet-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.85em;
    color: #657786;
    border-top: 1px solid #e1e8ed;
    padding-top: 8px;
    margin-top: auto; 
}

.custom-tweet-footer a {
    color: #1b95e0;
    text-decoration: none;
}
.custom-tweet-footer a:hover {
    text-decoration: underline;
}

.custom-tweet-loading,
.custom-tweet-error {
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100%; 
    min-height: 50px; /* Ensure loading/error message has some space */
    font-style: italic;
    color: #657786;
}
        `;
        document.head.appendChild(styleSheet);
    }

function createCustomTweetPlaceholderHTML(tweetId, originalUrl) {
    const escapedOriginalUrl = originalUrl.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    // The main container gets the class for fixed sizing and general appearance.
    // It also gets 'embed-placeholder' for the IntersectionObserver and 'custom-twitter' for type.
    return `
        <div class="custom-tweet-placeholder embed-placeholder" 
             data-embed-type="custom-twitter" 
             data-tweet-id="${tweetId}" 
             data-original-url="${escapedOriginalUrl}" 
             data-loaded="false">
            <div class="custom-tweet-header">
                <img class="custom-tweet-avatar" src="" alt="Avatar" style="display:none; background-color: #eee;">
                <div class="custom-tweet-author">
                    <span class="custom-tweet-displayname"></span>
                    <span class="custom-tweet-username"></span>
                </div>
            </div>
            <div class="custom-tweet-content">
                <!-- Content (text, images, videos) will be populated here -->
                <div class="custom-tweet-loading">Loading tweet...</div>
                <div class="custom-tweet-media">
                    <!-- Media items will be appended here -->
                </div>
            </div>
            <div class="custom-tweet-footer">
                <a href="${escapedOriginalUrl}" target="_blank" rel="noopener noreferrer">View on X/Twitter</a>
                <span class="custom-tweet-date"></span>
            </div>
        </div>
    `;
}

async function fetchAndRenderCustomTweet(tweetId, originalUrl, targetElement) {
    console.log(`[CustomTweet] Fetching data for ${tweetId}`);
    const loadingDiv = targetElement.querySelector('.custom-tweet-loading');
    const contentDiv = targetElement.querySelector('.custom-tweet-content'); // Main content area, not just media
    const mediaDiv = targetElement.querySelector('.custom-tweet-media');
    const avatarImg = targetElement.querySelector('.custom-tweet-avatar');
    const displayNameSpan = targetElement.querySelector('.custom-tweet-displayname');
    const usernameSpan = targetElement.querySelector('.custom-tweet-username');
    const dateSpan = targetElement.querySelector('.custom-tweet-date');

    // Clear previous media and hide loading message
    if (mediaDiv) mediaDiv.innerHTML = '';
    // If loadingDiv (initial "Loading tweet...") exists within contentDiv, ensure it's hidden.
    const initialLoadingDiv = contentDiv.querySelector('.custom-tweet-loading');
    if (initialLoadingDiv) initialLoadingDiv.style.display = 'none';

    // Default to showing an error, successful load will override
    const showError = (message) => {
        // Clear any previously rendered text content and media
        const textContentDisplay = contentDiv.querySelector('.custom-tweet-text-content');
        if (textContentDisplay) textContentDisplay.innerHTML = ''; // Clear actual text
        if (mediaDiv) mediaDiv.innerHTML = ''; // Clear media

        let errorDisplay = contentDiv.querySelector('.custom-tweet-error');
        if (!errorDisplay) {
            errorDisplay = document.createElement('div');
            errorDisplay.className = 'custom-tweet-error';
            // Add the error display as the first child of contentDiv
            contentDiv.insertBefore(errorDisplay, contentDiv.firstChild);
        }
        errorDisplay.textContent = message;
        errorDisplay.style.display = 'flex'; // Make sure it's visible

        targetElement.dataset.loaded = 'true'; // Mark as "loaded" to prevent re-fetch, even on error
    };

    try {
        // Extract user and status ID from originalUrl for vxtwitter
        const urlParts = originalUrl.match(/twitter\.com\/(.+)\/status\/(\d+)/);
        if (!urlParts || urlParts.length < 3) {
            throw new Error("Invalid tweet URL for API construction.");
        }
        const apiUrlUser = urlParts[1];
        const apiUrlTweetId = urlParts[2];
        const apiUrl = `https://api.vxtwitter.com/${apiUrlUser}/status/${apiUrlTweetId}`;

        console.log(`[CustomTweet] API URL: ${apiUrl}`);
        const response = await fetch(apiUrl);

        if (!response.ok) {
            throw new Error(`API request failed: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        console.log(`[CustomTweet] Data for ${tweetId}:`, data);

        if (!data || !data.user_name || !data.text) { // Basic check for essential data
            throw new Error("Tweet data incomplete or not found from API.");
        }

        // Populate header
        if (avatarImg && data.user_profile_image_url_https) {
            avatarImg.src = data.user_profile_image_url_https;
            avatarImg.alt = `${data.user_name}'s avatar`;
            avatarImg.style.display = 'block';
        }
        if (displayNameSpan) displayNameSpan.textContent = data.user_name;
        if (usernameSpan) usernameSpan.textContent = `@${data.screen_name || data.user_screen_name}`; // VXTwitter uses user_screen_name in tweet object, but sometimes screen_name in user object.

        // Populate content text
        // Ensure loading/error div is removed or hidden before adding text
        if (loadingDiv) loadingDiv.style.display = 'none';
        let errorDisplay = contentDiv.querySelector('.custom-tweet-error');
        if (errorDisplay) errorDisplay.style.display = 'none';

        let textContentDiv = contentDiv.querySelector('.custom-tweet-text-content');
        if (!textContentDiv) {
            textContentDiv = document.createElement('div');
            textContentDiv.className = 'custom-tweet-text-content';
            // Prepend text content div after any loading/error divs are handled
            if (mediaDiv) { // if mediaDiv exists, insert before it
                contentDiv.insertBefore(textContentDiv, mediaDiv);
            } else { // if no mediaDiv, just append to contentDiv
                contentDiv.appendChild(textContentDiv);
            }
        }
        textContentDiv.textContent = data.text;


        // Populate media
        if (mediaDiv) { // Ensure mediaDiv exists
            mediaDiv.innerHTML = ''; // Clear any previous media/loading text
            if (data.media_extended && Array.isArray(data.media_extended)) {
                data.media_extended.forEach(mediaItem => {
                    if (mediaItem.type === 'image' && mediaItem.url) {
                        const img = document.createElement('img');
                        img.src = mediaItem.url;
                        img.alt = 'Tweet image';
                        mediaDiv.appendChild(img);
                    } else if (mediaItem.type === 'video' && mediaItem.url) {
                        const video = document.createElement('video');
                        video.src = mediaItem.url;
                        video.controls = true;
                        // video.autoplay = false; // Default, but good to be explicit
                        // video.muted = true; // Good practice for autoplay, but we have controls
                        mediaDiv.appendChild(video);
                    }
                });
            }
        }


        // Populate footer
        if (dateSpan && data.date_epoch) {
            const date = new Date(data.date_epoch * 1000);
            dateSpan.textContent = date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
        }

        targetElement.dataset.loaded = 'true';

    } catch (error) {
        console.error(`[CustomTweet] Error fetching/rendering tweet ${tweetId}:`, error);
        showError(`Failed to load tweet: ${error.message}`);
    }
}


    // Helper: Find message by post id across all threads
    function findMessage(postId) {
        for (const threadId of activeThreads) {
            const msgs = messagesByThreadId[threadId] || [];
            for (const msg of msgs) {
                if (msg.id === parseInt(postId)) return { msg, threadId };
            }
        }
        return null;
    }

    // Render single message with recursive quoted messages above
    function renderMessageWithQuotes(msg, threadId, depth = 0, ancestors = [], embedCounts, renderedFullSizeImages, parentFrameId) { // Added parentFrameId
        if (ancestors.includes(msg.id)) {
            // Detected a circular quote, stop rendering this branch.
            // Return a comment node or an empty document fragment.
            const comment = document.createComment(`Skipping circular quote to post ${msg.id}`);
            return comment;
        }
        const color = threadColors[threadId] || '#888';

        // Create container div for quoted messages (recursively)
        const container = document.createElement('div');
        // container.style.marginLeft = `${depth * 20}px`; // Removed to align all messages
        if (depth === 0) {
            container.style.backgroundColor = '#fff';
            container.dataset.messageId = msg.id; // Set data-message-id for top-level messages

            // Add click event listener for selection
            container.addEventListener('click', function(event) {
                const currentSelectedId = localStorage.getItem(SELECTED_MESSAGE_KEY);
                const thisMessageId = String(msg.id); // Ensure string comparison

                // Deselect if clicking the already selected message
                if (currentSelectedId === thisMessageId) {
                    localStorage.removeItem(SELECTED_MESSAGE_KEY);
                    this.classList.remove('selected-message');
                } else {
                    // Remove highlight from previously selected message
                    const previouslySelected = viewer.querySelector('.selected-message');
                    if (previouslySelected) {
                        previouslySelected.classList.remove('selected-message');
                    }

                    // Store new selected message ID and highlight it
                    localStorage.setItem(SELECTED_MESSAGE_KEY, thisMessageId);
                    // sessionStorage.removeItem('otkLastScrolledMessageId'); // Removed for new scroll logic
                    console.log('[OTK Viewer Scroll] Cleared lastScrolledMessageId due to explicit selection.'); // Log can remain or be updated
                    this.classList.add('selected-message');
                }
                event.stopPropagation(); // Stop event from bubbling
            });

        } else {
            // Alternating backgrounds for quoted messages
            container.style.backgroundColor = (depth % 2 === 1) ? 'rgba(0,0,0,0.05)' : '#fff';
        }
        container.style.borderRadius = '4px';
        container.style.padding = '6px 8px';
        container.style.marginBottom = '8px';

        if (depth === 0) {
            container.style.borderBottom = '1px solid #ccc';
            // Optionally, adjust padding or margin if the border makes spacing awkward
            // For example, increase bottom padding or change margin:
            container.style.paddingBottom = '10px'; // Increase padding to give content space from border
            container.style.marginBottom = '15px'; // Increase margin to space out from next main message
        }

        // Find quotes in this message text
        const quoteIds = [];
        const quoteRegex = /&gt;&gt;(\d+)/g;
        let m;
        while ((m = quoteRegex.exec(msg.text)) !== null) {
            quoteIds.push(m[1]);
        }

        // Render quoted messages recursively (above)
        for (const qid of quoteIds) {
            const found = findMessage(qid);
            if (found) {
                const quotedEl = renderMessageWithQuotes(found.msg, found.threadId, depth + 1, [...ancestors, msg.id], embedCounts, renderedFullSizeImages);
                container.appendChild(quotedEl);
            }
        }

        // Create main message div
        const postDiv = document.createElement('div');
        postDiv.style.display = 'flex';
        postDiv.style.alignItems = 'flex-start';

        if (depth === 0) {
            // Color square
            const colorSquare = document.createElement('div');
            colorSquare.style.cssText = `
                width: 15px;
                height: 40px;
                background-color: ${color};
                border-radius: 3px;
                margin-right: 10px;
                flex-shrink: 0;
            `;
            postDiv.appendChild(colorSquare);
        }

        const textWrapperDiv = document.createElement('div');
        textWrapperDiv.style.display = 'flex';
        textWrapperDiv.style.flexDirection = 'column';

        // Post number and timestamp container
        const headerDiv = document.createElement('div');
        headerDiv.style.cssText = 'margin-right: 10px; font-size: 12px; color: #555; flex-shrink: 0; white-space: nowrap;';
        const dt = new Date(msg.time * 1000);
        headerDiv.textContent = `#${msg.id} ${dt.toLocaleString()}`;
        textWrapperDiv.appendChild(headerDiv);

        // Content
        const contentDiv = document.createElement('div');
        contentDiv.classList.add('post-content');
        contentDiv.style.whiteSpace = 'pre-wrap';
        contentDiv.innerHTML = convertQuotes(msg.text, embedCounts); // This now generates "Load Tweet" links
        // processAndReplaceTweetMarkers(contentDiv); // This function is removed
        textWrapperDiv.appendChild(contentDiv);

        if (msg.attachment && msg.attachment.tim) {
            const attach = msg.attachment;
            const board = 'b'; // Assuming 'b' for now, ideally this could be more dynamic if script were for multiple boards
            const thumbUrl = `https://i.4cdn.org/${board}/${attach.tim}s.jpg`;
            const fullUrl = `https://i.4cdn.org/${board}/${attach.tim}${attach.ext}`;

            const textWrapper = textWrapperDiv; // textWrapperDiv is where the thumb/full media will go

            const createThumbnail = () => {
                const thumbnailWrapper = document.createElement('div');
                // Optional: Add any specific styles to thumbnailWrapper if needed, e.g., thumbnailWrapper.style.marginBottom = '5px';

                const thumb = document.createElement('img');
                const board = 'b'; // Assuming 'b' for now
                const networkThumbUrl = `https://i.4cdn.org/${board}/${attach.tim}s.jpg`;

                // Initial setup for alt, title, and styles that apply to both placeholder and final image
                thumb.alt = attach.filename;
                thumb.title = 'Click to view ' + attach.filename + ' (' + attach.w + 'x' + attach.h + ')';
                // Ensure tn_w and tn_h are valid numbers before using them for styles
                if (typeof attach.tn_w === 'number' && attach.tn_w > 0) {
                    thumb.style.maxWidth = attach.tn_w + 'px';
                } else {
                    thumb.style.maxWidth = '150px'; // Default fallback
                }
                if (typeof attach.tn_h === 'number' && attach.tn_h > 0) {
                    thumb.style.maxHeight = attach.tn_h + 'px';
                } else {
                    thumb.style.maxHeight = '150px'; // Default fallback
                }
                thumb.style.cursor = 'pointer';
                thumb.style.marginTop = '5px';
                thumb.style.borderRadius = '3px';
                thumb.style.border = '1px solid transparent'; // Placeholder for border if needed
                thumb.style.display = 'block'; // Ensure this is present
                thumb.dataset.isThumbnail = "true";

                // Generic error handler for final failure (e.g., network error, corrupted cache)
                const showLoadError = function() {
                    console.warn('[OTK Cache/Thumb] Thumbnail failed to load definitively for original src:', networkThumbUrl);
                    this.alt = 'Image deleted or unavailable';
                    this.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"%3E%3Crect width="120" height="120" fill="%23e0e0e0"%3E%3C/rect%3E%3Ctext x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="14px" fill="%23757575"%3EImg N/A%3C/text%3E%3C/svg%3E';
                    this.style.width = '120px';
                    this.style.height = '120px';
                    this.style.maxWidth = '120px';
                    this.style.maxHeight = '120px';
                    this.style.objectFit = 'contain';
                    this.style.border = '1px dashed #aaa';
                    this.style.padding = '5px';
                    this.title = 'Image deleted or unavailable';
                    this.onerror = null; // Prevent loops
                    this.onload = null;  // Clear any pending onload
                };

                thumb.onerror = showLoadError; // Set early for any src assignment issues
                thumbnailWrapper.appendChild(thumb);


                (async () => {
                    try {
                        const cachedBlob = await getMedia(networkThumbUrl);
                        if (cachedBlob) {
                            console.log('[OTK Cache] createThumbnail: Using cached blob for', networkThumbUrl);
                            const objectURL = URL.createObjectURL(cachedBlob);
                            thumb.onload = () => {
                                URL.revokeObjectURL(objectURL); // Clean up after image is loaded
                                console.log('[OTK Cache] createThumbnail: ObjectURL loaded into img for', networkThumbUrl);
                                thumb.style.border = '1px solid transparent'; // Reset border on successful load
                                thumb.onload = null; // Clear this specific onload
                            };
                            // If ObjectURL fails to load, thumb.onerror (showLoadError) will trigger
                            thumb.src = objectURL;
                        } else {
                            console.log('[OTK Cache] createThumbnail: Not in cache, fetching from network:', networkThumbUrl);
                            thumb.onload = async function() { // Network image loaded successfully
                                console.log('[OTK Cache] createThumbnail: Network thumbnail loaded successfully:', networkThumbUrl);
                                try {
                                    // Fetch again to get blob for caching.
                                    // Use { cache: 'default' } or rely on browser's default caching for this fetch.
                                    // If the image just loaded into thumb.src, it might be in HTTP cache.
                                    const response = await fetch(networkThumbUrl); // This might fail due to CORS
                                    if (!response.ok) {
                                        console.warn(`[OTK Cache] createThumbnail: Network response not OK for blob fetch (${response.status}) for ${networkThumbUrl}. Thumbnail displayed from network, but not cached.`);
                                        // Do not throw error, allow image to be displayed from direct src set below.
                                    } else {
                                        const blobToCache = await response.blob();
                                        if (blobToCache.size > 0) {
                                            await saveMedia(networkThumbUrl, blobToCache, attach.filename, attach.ext);
                                        } else {
                                            console.warn('[OTK Cache] createThumbnail: Fetched blob for caching is empty, not caching:', networkThumbUrl);
                                    }
                                }
                                } catch (cacheFetchError) {
                                    // This catch is specifically for the fetch intended for caching.
                                    // If it fails (e.g., CORS), log it but don't trigger showLoadError if the image is already displaying via src.
                                    console.warn('[OTK Cache] createThumbnail: Failed to fetch for caching (likely CORS):', networkThumbUrl, cacheFetchError.message, '- Thumbnail should still display from network via img.src.');
                                }
                                // These lines belong outside the inner try-catch, but inside the onload.
                                thumb.style.border = '1px solid transparent'; // Reset border on successful load (assuming img.src loaded it)
                                this.onload = null; // Clear this specific onload
                            };
                            // If network fetch for the <img> tag src itself fails, thumb.onerror (showLoadError) will trigger.
                            thumb.src = networkThumbUrl;
                        }
                    } catch (err) { // This outer catch is for errors in getMedia or other unexpected issues
                        console.error('[OTK Cache] createThumbnail: Error in async loading logic or getMedia for', networkThumbUrl, err.message);
                        showLoadError.call(thumb); // Call error handler in context of thumb
                    }
})();

                thumb.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // 'attach' is from the outer scope of createThumbnail
                    const fullMedia = createFullMedia(); // createFullMedia also uses 'attach'
                    thumbnailWrapper.parentNode.replaceChild(fullMedia, thumbnailWrapper); // Replace wrapper
                });
                return thumbnailWrapper;
            };

            const createFullMedia = (parentFrameIdForMedia) => { // Added parentFrameIdForMedia
                // Entry log for createFullMedia
                console.log(`[OTK Video Debug - ${parentFrameIdForMedia || 'unknown_context'}] createFullMedia: ENTER. File: ${attach.filename}, Post: ${msg.no}, Ext: ${attach.ext}`);

                let mediaElement;
                if (['.jpg', '.jpeg', '.png', '.gif'].includes(attach.ext.toLowerCase())) {
                    mediaElement = document.createElement('img');
                    // Apply initial styles that don't depend on src, and alt/title
                    mediaElement.alt = attach.filename;
                    mediaElement.title = 'Click to view thumbnail for ' + attach.filename; // Or similar
                    mediaElement.style.maxWidth = '100%';
                    mediaElement.style.maxHeight = '70vh';
                    mediaElement.style.display = 'block';
                    mediaElement.style.marginTop = '5px';
                    mediaElement.style.borderRadius = '3px';
                    mediaElement.style.cursor = 'pointer';
                    // Ensuring the requested styles are present
                    mediaElement.style.width = 'auto';
                    mediaElement.style.height = 'auto';
                    mediaElement.style.objectFit = 'contain';
                    mediaElement.dataset.isThumbnail = "false";

                    const networkFullUrl = fullUrl; // fullUrl is already defined in createFullMedia's scope

                    // The existing onerror handler (added in previous steps)
                    const existingOnError = function() {
                        console.warn('[OTK Viewer Media] Full-size image failed to load (onerror triggered for):', this.src);
                        this.alt = 'Full image deleted or unavailable';
                        this.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="200" height="150" viewBox="0 0 200 150"%3E%3Crect width="200" height="150" fill="%23d3d3d3"%3E%3C/rect%3E%3Ctext x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="16px" fill="%23707070"%3EImage Unavailable%3C/text%3E%3C/svg%3E';
                        this.style.width = '200px';
                        this.style.height = '150px';
                        this.style.maxWidth = '200px';
                        this.style.maxHeight = '150px';
                        this.style.objectFit = 'contain';
                        this.style.border = '1px dashed #aaa';
                        this.style.padding = '10px';
                        this.style.backgroundColor = '#f0f0f0';
                        this.title = 'Full image deleted or unavailable';
                        this.onclick = null;
                        this.onerror = null;
                    };
                    mediaElement.onerror = existingOnError;

                    (async () => {
                        try {
                            const cachedBlob = await getMedia(networkFullUrl);
                            if (cachedBlob) {
                                console.log('[OTK Cache] createFullMedia (Image): Using cached blob for', networkFullUrl);
                                const objectURL = URL.createObjectURL(cachedBlob);
                                mediaElement.onload = () => {
                                    URL.revokeObjectURL(objectURL);
                                    console.log('[OTK Cache] createFullMedia (Image): ObjectURL loaded into img for', networkFullUrl);
                                    mediaElement.style.border = ''; // Clear any error border if one was set
                                    mediaElement.onload = null;
                                };
                                mediaElement.src = objectURL;
                            } else {
                                console.log('[OTK Cache] createFullMedia (Image): Not in cache, fetching from network:', networkFullUrl);
                                mediaElement.onload = async function() { // This onload is for the img.src = networkFullUrl
                                    console.log('[OTK Cache] createFullMedia (Image): Network full image displayed via img.src:', networkFullUrl);
                                    // Now, attempt to fetch for caching. This might fail due to CORS.
                                    try {
                                        const response = await fetch(networkFullUrl, { cache: 'default' });
                                        if (!response.ok) {
                                            console.warn(`[OTK Cache] createFullMedia (Image): Network response not OK for caching fetch (${response.status}) for ${networkFullUrl}. Image displayed from network, but not cached.`);
                                        } else {
                                            const blobToCache = await response.blob();
                                            if (blobToCache.size > 0) {
                                                await saveMedia(networkFullUrl, blobToCache, attach.filename, attach.ext);
                                            } else {
                                                console.warn('[OTK Cache] createFullMedia (Image): Fetched blob for caching is empty for', networkFullUrl);
                                            }
                                        }
                                    } catch (cacheFetchError) {
                                        console.warn('[OTK Cache] createFullMedia (Image): Failed to fetch for caching (likely CORS):', networkFullUrl, cacheFetchError.message, '- Image should still be displayed from network via img.src.');
                                    }
                                    mediaElement.style.border = ''; // Clear any error border (if one was set by a prior failed cache load attempt)
                                    this.onload = null; // Clear this specific onload handler
                                };
                                // mediaElement.onerror is already set to existingOnError. If this src load fails, it will trigger.
                                mediaElement.src = networkFullUrl; // Trigger network load for display
                            }
                        } catch (err) { // This outer catch is for errors in getMedia or other unexpected issues
                            console.error('[OTK Cache] createFullMedia (Image): Error in async loading logic or getMedia for', networkFullUrl, err.message);
                            existingOnError.call(mediaElement); // Call error handler in context of mediaElement
                        }
})();
                    // The click listener to revert to thumbnail is added AFTER this if/else if block by existing code.
                } else if (['.webm', '.mp4'].includes(attach.ext.toLowerCase())) {
                    const videoContainer = document.createElement('div');
                    videoContainer.className = 'direct-video-container'; // For potential styling
                    // Initial styles for videoContainer, set textContent to "Loading video..."
                    videoContainer.style.padding = '10px';
                    videoContainer.style.border = '1px solid #eee';
                    videoContainer.style.minHeight = '50px'; // Initial min height
                    videoContainer.style.display = 'flex';
                    videoContainer.style.alignItems = 'center';
                    videoContainer.style.justifyContent = 'center';
                    videoContainer.textContent = 'Loading video...';

                    const localParentFrameId = parentFrameIdForMedia || 'direct_media_unknown_frame';
                    console.log(`[OTK Direct Video - ${localParentFrameId}] Creating video player for: ${attach.filename}${attach.ext}`);

                    const videoElement = document.createElement('video');
                    videoElement.src = fullUrl; // Direct network URL
                    console.log(`[OTK Direct Video - ${localParentFrameId}] video.src set to: ${videoElement.src}`);

                    videoElement.controls = true;
                    videoElement.autoplay = false; // Explicitly false
                    videoElement.loop = true; // Keep loop true
                    videoElement.preload = 'metadata'; // Or 'auto'

                    // Styles
                    videoElement.style.backgroundColor = '#000';
                    videoElement.style.maxWidth = '100%';
                    videoElement.style.maxHeight = '70vh';
                    videoElement.style.display = 'block'; // Make it block to fill container

                    // Event listeners
                    videoElement.onloadeddata = () => console.log(`[OTK Direct Video - ${localParentFrameId}] LOADEDDATA for ${videoElement.src}. ReadyState: ${videoElement.readyState}`);
                    videoElement.onerror = (e) => {
                        console.error(`[OTK Direct Video - ${localParentFrameId}] ONERROR for ${videoElement.src}. Error:`, e, 'Video Error Code:', videoElement.error ? videoElement.error.code : 'N/A', 'NetworkState:', videoElement.networkState);
                        // Update container to show error
                        if (videoContainer && videoContainer.parentNode) { // Check if still in DOM
                             videoContainer.innerHTML = `<span style='color:red;'>Error loading video: ${attach.filename}. Right-click and open in new tab may work.</span>`;
                             videoContainer.style.padding = '10px'; // Restore some padding for the error message
                             videoContainer.style.border = '1px solid #ccc';
                        }
                    };
                    videoElement.onstalled = () => console.warn(`[OTK Direct Video - ${localParentFrameId}] STALLED for ${videoElement.src}`);
                    videoElement.onsuspend = () => console.warn(`[OTK Direct Video - ${localParentFrameId}] SUSPEND for ${videoElement.src}`);

                    // Clear container and add video
                    videoContainer.innerHTML = ''; // Clear "Loading video..."
                    videoContainer.style.padding = '0';
                    videoContainer.style.border = 'none';
                    videoContainer.style.minHeight = ''; // Reset minHeight
                    videoContainer.style.display = 'block'; // Ensure container itself is block
                    videoContainer.appendChild(videoElement);

                    // console.log(`[OTK Direct Video - ${localParentFrameId}] Calling .load() for ${videoElement.src}`);
                    // videoElement.load(); // Explicitly call load - often not needed if src is set and element is in DOM.
                    // Browser should attempt to load metadata/data based on preload attribute.

                    mediaElement = videoContainer; // mediaElement is the container which will have the click listener
                } else {
                    // Fallback for unsupported types, or just don't create mediaElement
                    const unsupportedText = document.createElement('span');
                    unsupportedText.textContent = `[Unsupported file type: ${attach.ext}]`;
                    return unsupportedText;
                }

                mediaElement.style.maxWidth = '100%';
                mediaElement.style.maxHeight = '70vh';
                mediaElement.style.display = 'block';
                mediaElement.style.marginTop = '5px';
                mediaElement.style.borderRadius = '3px';
                mediaElement.style.cursor = 'pointer';
                // ---- START of intended changes for image elements ----
                mediaElement.style.width = 'auto';
                mediaElement.style.height = 'auto';
                mediaElement.style.objectFit = 'contain';
                // ---- END of intended changes for image elements ----
                mediaElement.dataset.isThumbnail = "false"; // Mark as full media

                if (['.webm', '.mp4'].includes(attach.ext.toLowerCase())) {
                    // For videos, clicking the video itself toggles play/pause
                    const videoElement = mediaElement.querySelector('video'); // mediaElement is the container
                    if (videoElement) {
                        mediaElement.addEventListener('click', (e) => {
                            e.stopPropagation(); // Prevent event from bubbling to any parent listeners
                            e.preventDefault(); // Prevent default browser action for click on video (like full screen)
                            if (videoElement.paused || videoElement.ended) {
                                videoElement.play();
                            } else {
                                videoElement.pause();
                            }
                        });
                    }
                } else {
                    // For images, clicking reverts to thumbnail
                    mediaElement.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const newThumbnail = createThumbnail();
                        if (mediaElement.parentNode) { mediaElement.parentNode.replaceChild(newThumbnail, mediaElement); } else { console.error('[OTK Viewer] Error reverting to thumbnail: full media element has no parent.'); }
                    });
                }
                return mediaElement;
            };

            // const textWrapper = textWrapperDiv; // Already defined

            // createThumbnail and createFullMedia are defined within this scope
            // We need to pass 'attach' to them explicitly if they don't already capture it.
            // Looking at the code, createThumbnail and createFullMedia capture 'attach' from their parent scope.

            const attachExt = attach.ext.toLowerCase();

            if (attachExt === '.webm' || attachExt === '.mp4') {
                // Pass parentFrameId (received by renderMessageWithQuotes) to createFullMedia
                console.log(`[OTK Viewer] Directly embedding video player for: ${attach.filename}${attachExt} in frame:`, parentFrameId);
                const fullVideoPlayer = createFullMedia(parentFrameId);
                contentDiv.appendChild(fullVideoPlayer);
            } else { // Handles images (jpg, png, gif)
                if (renderedFullSizeImages.has(attach.tim)) {
                    // Already shown full-size, render as thumbnail
                    // parentFrameId is relevant for context logging even for thumbnails if we desire
                    console.log(`[OTK Viewer] Rendering REPEAT image as thumbnail: ${attach.filename}${attach.ext} (TIM: ${attach.tim}) in frame:`, parentFrameId);
                    const initialThumb = createThumbnail();
                    contentDiv.appendChild(initialThumb);
                } else {
                    // First time seeing this image, render full-size
                     // Pass parentFrameId to createFullMedia for images too, for consistency or future use
                    console.log(`[OTK Viewer] Rendering FIRST instance of image as FULL-SIZE: ${attach.filename}${attach.ext} (TIM: ${attach.tim}) in frame:`, parentFrameId);
                    const fullImageDisplay = createFullMedia(parentFrameId);
                    contentDiv.appendChild(fullImageDisplay);
                    renderedFullSizeImages.add(attach.tim);
                }
            }
        } // End of if (msg.attachment && msg.attachment.tim)
        postDiv.appendChild(textWrapperDiv);

        container.appendChild(postDiv);
        return container;
    }

    // Render all messages chronologically across all threads
    async function renderAllMessages() { // Ensure it's async (already was)
        console.log('[OTK Video Debug - renderAllMessages] ENTER. isManualViewerRefreshInProgress (at start of func):', isManualViewerRefreshInProgress); // Added/modified log
        await new Promise(r => setTimeout(r, 50)); // Increased delay
        console.log('[OTK Viewer LIFECYCLE] renderAllMessages: Entered after increased delay. Clearing viewer and message tracking for full re-render.');

        // Always clear viewer and known message IDs for a full re-render
        viewer.innerHTML = '';
        lastKnownMessageIds.clear();
        const renderedFullSizeImages = new Set();

        console.log('[OTK Viewer] renderAllMessages: Cleared viewer content and lastKnownMessageIds.');

        if (embedObserver) {
            embedObserver.disconnect(); // Disconnect previous observer if any
        }
        const observerOptions = {
            root: viewer, // Observe intersections within the viewer scrollable area
            rootMargin: '700px 0px 700px 0px', // Load when 700px from viewport edge (INCREASED SENSITIVITY)
            threshold: 0.01 // Trigger when even 1% is visible
        };
        embedObserver = new IntersectionObserver(handleIntersection, observerOptions);

        // Gather all messages in one array with threadId info
        let allMessages = [];
        activeThreads.forEach(threadId => {
            const msgs = messagesByThreadId[threadId] || [];
            msgs.forEach(m => allMessages.push({ ...m, threadId }));
        });

        // Sort by time ascending
        allMessages.sort((a, b) => a.time - b.time);
        // if (loadingOverlay) loadingOverlay.textContent = 'Processing media and attachments...'; // Removed
        showLoadingOverlay("Gathering and sorting messages..."); // Restored

        console.log(`[OTK Viewer Metrics] renderAllMessages: Processing ${allMessages.length} total messages for display.`);
        let attachmentStats = { images: 0, videos: 0, other: 0 };
        let embedCounts = { youtube: 0, twitch: 0, streamable: 0 };

        // Render all messages
        console.log(`[OTK Video Debug - renderAllMessages] About to render ${allMessages.length} messages. Parent frame context for these messages will be 'initial_render_frame'.`); // Added
        // console.log('[OTK Viewer LIFECYCLE] renderAllMessages: About to start allMessages.forEach loop. Message count: ' + allMessages.length); // Original log
        try {
            allMessages.forEach(msg => {
                console.log('[OTK Viewer LIFECYCLE] renderAllMessages: Loop: START processing message ID ' + msg.id);

                // The old logic for __FULL_TWITTER_EMBED__ markers is removed.
                // convertQuotes will now directly handle twitter URLs and create custom tweet placeholders.
                const msgEl = renderMessageWithQuotes(msg, msg.threadId, 0, [], embedCounts, renderedFullSizeImages, 'initial_render_frame');

                // Selection class is now primarily handled by restoreSelectedMessageState upon loading all messages
                viewer.appendChild(msgEl);
            console.log(`[OTK Video Debug - renderAllMessages] Appended message element for ID ${msg.id}. Videos within should now attempt to load via their own .load() calls if correctly set up in createFullMedia.`); // Added
            // Inside the allMessages.forEach loop, after msgEl is created
            if (msg.attachment && msg.attachment.ext) {
                const ext = msg.attachment.ext.toLowerCase();
                if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
                    attachmentStats.images++;
                } else if (['.webm', '.mp4'].includes(ext)) {
                    attachmentStats.videos++;
                } else {
                    attachmentStats.other++;
                }
            }
            console.log('[OTK Viewer LIFECYCLE] renderAllMessages: Loop: END processing message ID ' + msg.id);
        });
    } catch (e) {
        console.error('[OTK Viewer] CRITICAL ERROR in renderAllMessages loop:', e.message, e.stack);
        showLoadingOverlay(`Error rendering messages: ${e.message}`);
        // Do not proceed further if the main loop fails catastrophically.
        return;
    }
        console.log('[OTK Viewer LIFECYCLE] renderAllMessages: Successfully FINISHED allMessages.forEach loop (or caught an error).');
        // if (loadingOverlay) loadingOverlay.textContent = 'Rendering content...'; // Removed
        showLoadingOverlay("Rendering content..."); // Restored

        // Add listener for quote links to scroll to quoted message
        viewer.querySelectorAll('a.quote').forEach(link => {
            link.addEventListener('click', e => {
                e.preventDefault();
                const targetId = parseInt(link.dataset.postid);
                // Scroll to message with this id if found
                const targets = viewer.querySelectorAll('div');
                for (const el of targets) {
                    if (el.textContent.includes(`#${targetId} `)) {
                        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        // Highlight briefly
                        el.style.backgroundColor = '#ffff99';
                        setTimeout(() => {
                            el.style.backgroundColor = '';
                        }, 1500);
                        break;
                    }
                }
            });
        });

        console.log('[OTK Viewer Metrics] renderAllMessages: Attachment stats from processed messages:');
        console.log(`    - Images: ${attachmentStats.images}`);
        console.log(`    - Videos: ${attachmentStats.videos}`);
        console.log(`    - Other: ${attachmentStats.other}`);
        console.log('[OTK Viewer Metrics] renderAllMessages: Embed counts from processed messages:');
        console.log(`    - YouTube: ${embedCounts.youtube}`);
        console.log(`    - Twitch: ${embedCounts.twitch}`);
        console.log(`    - Streamable: ${embedCounts.streamable}`);
        try {
            const renderedMessageElements = viewer.querySelectorAll('div[data-message-id]');
            console.log(`[OTK Viewer Metrics] renderAllMessages: Rendered ${renderedMessageElements.length} top-level message DOM elements.`);
        } catch(e) {
            console.error('[OTK Viewer Metrics] Error counting rendered message elements:', e);
        }

        // After all messages are in the DOM, process any Twitter embed placeholders
        if (!isManualViewerRefreshInProgress) { // Only for full renders
            lastKnownMessageIds.clear(); // Clear again just in case, then populate
            allMessages.forEach(msg => lastKnownMessageIds.add(String(msg.id)));
            console.log(`[OTK Viewer] Populated lastKnownMessageIds with ${lastKnownMessageIds.size} message IDs after full render.`);
        }

        showLoadingOverlay("Processing tweets and embeds..."); // Restored
        // console.log('[OTK Loading Debug] renderAllMessages: BEFORE await processTweetEmbeds'); // Kept for debugging if necessary
        // await processTweetEmbeds(viewer); // Ensure this is awaited (already was) // COMMENTED OUT FOR IO TEST
        // console.log('[OTK Loading Debug] renderAllMessages: AFTER await processTweetEmbeds'); // Kept for debugging if necessary
        showLoadingOverlay("Finalizing view..."); // Restored
        // if (loadingOverlay) loadingOverlay.textContent = 'Finalizing view...'; // Removed

        console.log(`[OTK Tweet DEBUG - renderAllMessages] PRE-CALL ensureTwitterWidgetsLoaded. Viewer element:`, viewer, `Is viewer connected: ${viewer && viewer.isConnected}`);
        // await ensureTwitterWidgetsLoaded(); // This call was here, but it's also called inside processTweetEmbeds.
                                          // If ensureTwitterWidgetsLoaded is idempotent, this is fine.
                                          // For now, let's assume the one in processTweetEmbeds is the primary one.
        console.log(`[OTK Tweet DEBUG - renderAllMessages] Twitter widgets supposedly loaded (or will be by processTweetEmbeds). PRE-CALL processTweetEmbeds.`);
        // await processTweetEmbeds(viewer); // COMMENTED OUT FOR IO TEST
        console.log(`[OTK Tweet DEBUG - renderAllMessages] POST-CALL processTweetEmbeds. (Call was commented out)`);

        const currentPlaceholders = viewer.querySelectorAll('.embed-placeholder'); // Simplified selector
        console.log(`[OTK Viewer IO] Observing ${currentPlaceholders.length} media placeholders (selector now only .embed-placeholder).`);
        currentPlaceholders.forEach(ph => {
            if (embedObserver) embedObserver.observe(ph);
        });

        if (!viewer.dataset.scrollListenerAttached) {
            // const debouncedViewerScrollHandler = debounce(handleViewerScroll, 500); // 500ms debounce
            // viewer.addEventListener('scroll', debouncedViewerScrollHandler);
            // viewer.dataset.scrollListenerAttached = 'true';
            // console.log('[OTK Viewer Scroll] Attached debounced scroll listener to viewer.');
            // New scroll logic does not require this listener.
        }

        // Call manageInitialScroll directly, it's async and will handle final overlay hide and viewer display
        await manageInitialScroll();
        console.log('[OTK Viewer LIFECYCLE] renderAllMessages: manageInitialScroll has completed.');
    }

async function appendNewMessagesToFrame() {
    console.log('[OTK Viewer] appendNewMessagesToFrame: Initiated.');
    // Overlay is expected to be already visible from otkMessagesUpdated
    // but we set the text content specifically for this phase.
    // appendNewMessagesToFrame now returns a boolean: true if messages were appended, false otherwise.
    // Overlay management is adjusted: this function updates text, but only hides overlay if NO new messages.
    // If messages ARE appended, the CALLER (otkMessagesUpdated) is responsible for hiding the overlay AFTER scroll restoration.
    console.log('[OTK Viewer] appendNewMessagesToFrame: Initiated.');
    showLoadingOverlay('Fetching new messages...'); // Ensure overlay is visible and set initial message.


    // Retrieve all messages from localStorage
    let currentActiveThreads = JSON.parse(localStorage.getItem(THREADS_KEY)) || [];
    let currentMessagesByThreadId = JSON.parse(localStorage.getItem(MESSAGES_KEY)) || {};
    // threadColors are not strictly needed here unless renderMessageWithQuotes depends on the global var being perfectly up to date.
    // For safety, we can load it, though it's not modified by this function.
    let currentThreadColors = JSON.parse(localStorage.getItem(COLORS_KEY)) || {};


    let allCurrentMessages = [];
    currentActiveThreads.forEach(threadId => {
        const msgs = currentMessagesByThreadId[threadId] || [];
        msgs.forEach(m => allCurrentMessages.push({ ...m, threadId }));
    });
    allCurrentMessages.sort((a, b) => a.time - b.time);

    const newMessages = allCurrentMessages.filter(msg => !lastKnownMessageIds.has(String(msg.id)));

    if (newMessages.length === 0) {
        showLoadingOverlay('No new messages found.'); // Update text, overlay is already shown
        setTimeout(hideLoadingOverlay, 2000); // Hide after a delay
        console.log('[OTK Viewer] appendNewMessagesToFrame: No new messages found.');
        // isManualViewerRefreshInProgress = false; // This flag is managed by the caller (otkMessagesUpdated)
        return false; // No messages appended
    }

    console.log(`[OTK Viewer] appendNewMessagesToFrame: Found ${newMessages.length} new messages to append.`);
    showLoadingOverlay('Processing new messages...'); // Update progress

    const newFrame = document.createElement('div');
    // Assign an ID to newFrame (the divider element) for context
    newFrame.id = `otk-frame-${Date.now()}-${Math.random().toString(36).substring(2,7)}`;
    console.log('[OTK Viewer] appendNewMessagesToFrame: Created new frame (divider) with ID:', newFrame.id);
    const timestamp = new Date().toLocaleString();
    newFrame.innerHTML = `<hr style="border-top: 2px dashed #007bff; margin: 20px 0;"><p style="text-align: center; color: #007bff; font-weight: bold;">New messages loaded at ${timestamp} (Frame: ${newFrame.id})</p>`;
    newFrame.style.marginBottom = '20px';
    // Append the divider immediately
    viewer.appendChild(newFrame);

    // Initialize counters for this batch of new messages
    const renderedFullSizeImagesThisBatch = new Set();
    let embedCountsThisBatch = { youtube: 0, twitch: 0, streamable: 0 };

    const newMessagesFragment = document.createDocumentFragment();
    const newPlaceholdersToObserve = [];
    const collectedVideoElements = [];
    const newTweetsContainer = document.createElement('div'); // Container for new tweets
    newTweetsContainer.id = `otk-new-tweets-frame-${Date.now()}`;
    let hasNewTweetsToRenderFully = false;

    // Separate new tweets to render them fully and first
    const nonTweetMessages = [];
    const tweetMessagesToRenderFully = [];

    newMessages.forEach(msg => {
        const twitterLinks = msg.text.matchAll(/https?:\/\/(?:twitter\.com|x\.com)\/[a-zA-Z0-9_]+\/status\/([0-9]+)/g);
        let isNewTweetMessage = false;
        for (const match of twitterLinks) {
            // For simplicity, any message containing a new tweet link will be processed this way.
            // More sophisticated logic could check if *this specific tweet ID* is new to the viewer.
            isNewTweetMessage = true;
            break;
        }

        if (isNewTweetMessage) {
            tweetMessagesToRenderFully.push(msg);
        } else {
            nonTweetMessages.push(msg);
        }
    });

    // Render fully new tweets first and prepend them
    if (tweetMessagesToRenderFully.length > 0) {
        hasNewTweetsToRenderFully = true;
        const newTweetsFragment = document.createDocumentFragment();
        console.log(`[OTK Viewer] Rendering ${tweetMessagesToRenderFully.length} new messages containing tweets fully.`);

        for (const msg of tweetMessagesToRenderFully) {
            // The old logic for __FULL_TWITTER_EMBED__ markers is removed.
            // convertQuotes will now directly handle twitter URLs.
            const msgEl = renderMessageWithQuotes(msg, msg.threadId, 0, [], embedCountsThisBatch, renderedFullSizeImagesThisBatch, newFrame.id);

            const placeholdersInMsg = msgEl.querySelectorAll('.embed-placeholder');
            placeholdersInMsg.forEach(ph => newPlaceholdersToObserve.push(ph));
            const videosInMsg = msgEl.querySelectorAll('video');
            videosInMsg.forEach(vid => collectedVideoElements.push(vid));
            newTweetsFragment.appendChild(msgEl);
            lastKnownMessageIds.add(String(msg.id));
        }
        newTweetsContainer.appendChild(newTweetsFragment);
        // Prepend the new tweets container *before* the "New messages loaded at..." divider (newFrame)
        viewer.insertBefore(newTweetsContainer, newFrame);
    }


    // Render other non-tweet new messages
    nonTweetMessages.forEach(msg => {
        const msgEl = renderMessageWithQuotes(msg, msg.threadId, 0, [], embedCountsThisBatch, renderedFullSizeImagesThisBatch, newFrame.id);
        const placeholdersInMsg = msgEl.querySelectorAll('.embed-placeholder');
        placeholdersInMsg.forEach(ph => newPlaceholdersToObserve.push(ph));
        const videosInMsg = msgEl.querySelectorAll('video');
        videosInMsg.forEach(vid => collectedVideoElements.push(vid));
        newMessagesFragment.appendChild(msgEl);
        lastKnownMessageIds.add(String(msg.id));
    });

    viewer.appendChild(newMessagesFragment); // Append non-tweet new messages after the divider
    console.log(`[OTK Viewer] Appended ${newMessages.length} new messages (tweets fully rendered: ${tweetMessagesToRenderFully.length}, other: ${nonTweetMessages.length}). lastKnownMessageIds size: ${lastKnownMessageIds.size}`);

    // ---- START: New video processing logic ----
    if (collectedVideoElements.length > 0) {
        console.log('[OTK Video Debug] appendNewMessagesToFrame: Processing', collectedVideoElements.length, 'collected video elements for frame', newFrame.id);
        collectedVideoElements.forEach(video => {
            // video is now in the live DOM as part of newMessagesFragment's children
            console.log('[OTK Video Debug] appendNewMessagesToFrame: Found video in newly appended content. SRC:', video.src, 'ID:', video.id, '. Attaching event listeners and calling .load().');

            const newVideo = video.cloneNode(true); // Clone to ensure clean event listeners
            if (video.parentNode) {
                video.parentNode.replaceChild(newVideo, video);
            } else {
                // This case should ideally not happen if videos are collected from elements just added to fragment
                console.warn('[OTK Video Debug] appendNewMessagesToFrame: Original video has no parentNode before replacement. Video src:', video.src);
            }

            newVideo.onloadeddata = () => console.log('[OTK Video Debug] appendNewMessagesToFrame: onloadeddata event for video:', newVideo.src, 'Frame ID:', newFrame.id);
            newVideo.onerror = (e) => console.error('[OTK Video Debug] appendNewMessagesToFrame: onerror event for video:', newVideo.src, 'Error:', e, 'Frame ID:', newFrame.id);

            if (newVideo.src && (newVideo.src.startsWith('blob:') || newVideo.src.startsWith('http'))) {
                 console.log('[OTK Video Debug] appendNewMessagesToFrame: Attempting to load video:', newVideo.src);
                 newVideo.load();
            } else {
                 console.warn('[OTK Video Debug] appendNewMessagesToFrame: Video source is not a blob/http or is empty, not calling load():', newVideo.src);
            }
        });
    }
    // ---- END: New video processing logic ----

    showLoadingOverlay('Observing new media and processing embeds...');

    if (embedObserver && newPlaceholdersToObserve.length > 0) {
        console.log(`[OTK Viewer IO] Observing ${newPlaceholdersToObserve.length} new media placeholders added by append.`);
        newPlaceholdersToObserve.forEach(ph => embedObserver.observe(ph));
    } else {
        if (!embedObserver) console.warn("[OTK Viewer IO] embedObserver not initialized when trying to observe new placeholders in appendNewMessagesToFrame.");
        if (newPlaceholdersToObserve.length === 0) console.log("[OTK Viewer IO] No new placeholders to observe in appendNewMessagesToFrame.");
    }

    // Explicitly load newly added video elements -- THIS BLOCK IS NOW REPLACED BY THE LOGIC ABOVE
    // if (newVideoElements.length > 0) {
    //     console.log(`[OTK Viewer Media] Calling .load() on ${newVideoElements.length} newly appended video elements.`);
    //     newVideoElements.forEach(videoEl => {
    //         if (videoEl.src && typeof videoEl.load === 'function') {
    //             videoEl.load();
    //         } else if (!videoEl.src) {
    //             console.warn('[OTK Viewer Media] Video element has no src, cannot call load:', videoEl);
    //         }
    //     });
    // }

    console.log('[OTK Viewer Tweets DEBUG] appendNewMessagesToFrame: Calling processTweetEmbeds for viewer div after appending new frame.');
    // console.log('[OTK Loading Debug] appendNewMessagesToFrame: BEFORE await processTweetEmbeds'); // Original log, can be removed or kept
    // await processTweetEmbeds(viewer); // COMMENTED OUT FOR IO TEST
    // console.log('[OTK Loading Debug] appendNewMessagesToFrame: AFTER await processTweetEmbeds'); // Original log, can be removed or kept

    showLoadingOverlay('Finalizing new content display...');

    // Scroll position should ideally not change as content is added at the bottom.
    // However, if a specific scroll adjustment is needed later, it would go here.

    // Hiding of overlay will be handled by the caller (otkMessagesUpdated) after scroll restoration.
    // isManualViewerRefreshInProgress is also reset by the caller.
    // For safety, if this function were ever called directly and not via otkMessagesUpdated:
    // if (loadingOverlay) hideLoadingOverlay();
    // if (isManualViewerRefreshInProgress) isManualViewerRefreshInProgress = false;
    console.log('[OTK Viewer] appendNewMessagesToFrame: Finished processing new messages.');
    return true; // Messages were appended
}

    // Toggle viewer display
    async function toggleViewer() { // Made async
        const bar = document.getElementById('otk-thread-bar'); // Get the black bar

        if (viewer.style.display === 'none' || viewer.style.display === '') { // Logic to SHOW viewer
            console.log('[OTK Viewer] toggleViewer: Attempting to SHOW viewer.');
            // console.log('[OTK Viewer EXECUTION] toggleViewer: Path to SHOW viewer entered (after initial display check).');

            showLoadingOverlay("Loading messages..."); // Reverted to helper function

            localStorage.setItem('otkViewerVisible', 'true');
            // viewer.style.display = 'block'; // This line is REMOVED. Viewer will be shown by manageInitialScroll.
            renderAllMessages(); // Render content first

            // Adjust viewer padding and hide other page elements
            const barElement = document.getElementById('otk-thread-bar'); // bar is already defined at function scope
            let calculatedPaddingTop = '60px'; // Default/fallback if bar not found or height is 0
            if (barElement && barElement.offsetHeight > 0) {
                calculatedPaddingTop = barElement.offsetHeight + 'px';
            }
            viewer.style.paddingTop = calculatedPaddingTop;
            viewer.style.paddingLeft = '20px'; // Ensure consistent padding
            viewer.style.paddingRight = '20px';
            viewer.style.paddingBottom = '10px';

            originalBodyOverflow = document.body.style.overflow;
            document.body.style.overflow = 'hidden';
            otherBodyNodes = [];
            Array.from(document.body.childNodes).forEach(node => {
                if (node !== viewer && node !== bar && node.nodeType === Node.ELEMENT_NODE) {
                    if (node.style && node.style.display !== 'none') {
                        otherBodyNodes.push({ node: node, originalDisplay: node.style.display });
                        node.style.display = 'none';
                    } else if (!node.style && node.tagName !== 'SCRIPT' && node.tagName !== 'LINK') {
                        otherBodyNodes.push({ node: node, originalDisplay: '' });
                        node.style.display = 'none';
                    }
                }
            });

            if (bar) { // 'bar' is already defined at the top of toggleViewer
                bar.style.zIndex = '10000';
            }
        } // END OF IF BLOCK TO SHOW VIEWER
        else { // Logic to HIDE viewer
            // ... (ensure this part remains correct as it was)
            console.log('[OTK Viewer] toggleViewer: Attempting to HIDE viewer.');
            viewer.style.paddingTop = '10px'; // Reset to default padding
            viewer.style.paddingLeft = '20px';
            viewer.style.paddingRight = '20px';
            viewer.style.paddingBottom = '10px';
            viewer.style.display = 'none';
            document.body.style.overflow = originalBodyOverflow;

            otherBodyNodes.forEach(item => {
                item.node.style.display = item.originalDisplay;
            });
            otherBodyNodes = [];

            if (bar) { // 'bar' is already defined
                bar.style.zIndex = '9999';
            }
            if (embedObserver) {
                console.log('[OTK Viewer IO] Disconnecting IntersectionObserver as viewer is hidden.');
                embedObserver.disconnect();
            }
            if (loadingOverlay) {
                // loadingOverlay.style.display = 'none'; // Replaced by helper
                hideLoadingOverlay();
                console.log('[OTK Loading Overlay] Overlay hidden by toggleViewer (hiding main viewer).');
            }
            localStorage.setItem('otkViewerVisible', 'false');
        }
    }

    // Listen for toggle event from thread tracker script
    window.addEventListener('otkToggleViewer', toggleViewer);

    // Auto-open viewer if it was visible before refresh
    const viewerWasVisible = localStorage.getItem('otkViewerVisible');
    console.log('[OTK Viewer] Init: viewerWasVisible from localStorage:', viewerWasVisible);
    const initialSelectedId = localStorage.getItem(SELECTED_MESSAGE_KEY); // Assuming SELECTED_MESSAGE_KEY is 'otkSelectedMessageId'
    console.log('[OTK Viewer] Init: initialSelectedId from localStorage:', initialSelectedId);
    if (viewerWasVisible === 'true') {
        console.log('[OTK Viewer EXECUTION] Initial load: viewerWasVisible is true. Delaying toggleViewer() call by 500ms.');
        setTimeout(() => {
            console.log('[OTK Viewer EXECUTION] Executing delayed toggleViewer() for initial auto-open.');
            toggleViewer();
        }, 500); // Delay of 500 milliseconds
    }

    // REMOVED: Event listener for "Load Tweet" links as custom tweets load via IntersectionObserver.
    // The old 'load-tweet-link' class and associated logic are no longer used.

    window.addEventListener('beforeunload', () => {
        if (viewer && viewer.style.display === 'block') { // Check if viewer exists and is visible
            // const capturedState = captureLineAnchoredScrollState();
            // if (capturedState) {
            //     localStorage.setItem(PAGE_REFRESH_ANCHOR_STATE_KEY, JSON.stringify(capturedState));
            //     console.log('[OTK Scroll Lines] Saved line anchored state for F5 refresh:', capturedState);
            // } else {
            //     localStorage.removeItem(PAGE_REFRESH_ANCHOR_STATE_KEY);
            //     console.log('[OTK Scroll Lines] No valid anchor state captured for F5 refresh, cleared stale data.');
            // }
        } else {
            // If viewer is not visible, clear any previous F5 anchor state, as it's no longer relevant.
            // localStorage.removeItem(PAGE_REFRESH_ANCHOR_STATE_KEY);
            // console.log('[OTK Scroll Lines] Viewer not visible on unload, cleared F5 anchor state.');
        }
    });

window.addEventListener('otkMessagesUpdated', async () => { // make it async
    console.log('[OTK Viewer EXECUTION] Event: otkMessagesUpdated received.');
    if (viewer.style.display === 'block') { // Check if viewer is active
        const manualRefreshClicked = sessionStorage.getItem('otkManualRefreshClicked');

        if (manualRefreshClicked === 'true') {
            sessionStorage.removeItem('otkManualRefreshClicked');
            console.log('[OTK Viewer] Manual refresh trigger detected. Attempting to append new messages.');
            isManualViewerRefreshInProgress = true;
            // appendNewMessagesToFrame will show its own more specific loading messages.
            // We can show a generic one here if desired, but appendNewMessagesToFrame is quite vocal.
            // showLoadingOverlay('Checking for new messages...');

            // Load the latest data from localStorage for the append function to use
            // Note: appendNewMessagesToFrame also loads data from localStorage internally.
            // This is slightly redundant but ensures the global script vars are also fresh if anything else were to use them immediately.
            activeThreads = JSON.parse(localStorage.getItem(THREADS_KEY)) || [];
            messagesByThreadId = JSON.parse(localStorage.getItem(MESSAGES_KEY)) || {};
            threadColors = JSON.parse(localStorage.getItem(COLORS_KEY)) || {};

            const newMessagesWereAppended = await appendNewMessagesToFrame();

            if (newMessagesWereAppended) {
                // appendNewMessagesToFrame shows "Finalizing new content display..."
                // and then it's the responsibility of THIS function to hide the overlay
                // if messages were appended.
                console.log('[OTK Viewer] New messages appended by manual refresh. Finalizing display shortly.');
                // A short delay can be added here if needed before hiding, but appendNewMessagesToFrame has its own internal delays/messages.
                // For now, trust appendNewMessagesToFrame to leave the overlay in a "finalizing" state.
                // The hideLoadingOverlay after a delay will catch it.
                showLoadingOverlay('New messages loaded.'); // Update overlay text
                setTimeout(hideLoadingOverlay, 1500); // Hide after a short delay
            }
            // If newMessagesWereAppended is false, appendNewMessagesToFrame handles its own "No new messages" overlay and timeout.

            isManualViewerRefreshInProgress = false;
            console.log('[OTK Viewer] Manual refresh process (append attempt) complete.');

        } else {
            // This is a background update (not a manual click from tracker's refresh button)
            console.log('[OTK Viewer] Background update detected by otkMessagesUpdated event. No action taken in viewer unless manual refresh is clicked.');
            // No actual data loading or re-rendering happens here.
            // The tracker script would have updated localStorage in the background.
            // The viewer will only reflect these changes upon the next manual "Refresh Threads/Messages" click.
        }
    } else {
        console.log('[OTK Viewer EXECUTION] Event: otkMessagesUpdated received, but viewer is not visible. No action taken.');
    }
});

// Listen for clear event from tracker script
window.addEventListener('otkClearViewerDisplay', () => {
    console.log('[OTK Viewer EXECUTION] Event: otkClearViewerDisplay received.');
    if (viewer) {
        viewer.innerHTML = ''; // Clear the viewer content
        console.log('[OTK Viewer] Cleared viewer content.');
    }
    lastKnownMessageIds.clear();
    console.log('[OTK Viewer] Cleared lastKnownMessageIds.');

    if (embedObserver) {
        embedObserver.disconnect();
        console.log('[OTK Viewer IO] Disconnected IntersectionObserver due to clear event.');
    }

    // Optionally, reset other states if necessary, e.g.
    // renderedFullSizeImages.clear(); // If it were global

    if (viewer && viewer.style.display === 'block') { // Only show overlay if viewer was visible
        showLoadingOverlay("Viewer cleared. Waiting for new data from tracker...");
        // The overlay will be hidden when new data eventually loads or if toggled off.
    }
});


// === Manual Refresh + Background Sync ===
let backgroundMessageCache = [];
let lastFetchTime = 0;
const fetchInterval = 60 * 1000; // 1 minute
const newMessageFrameId = 'manual-new-message-frame';

// Inject refresh button
const refreshBtn = document.createElement('button');
refreshBtn.textContent = '🔄 Refresh Threads / Messages';
refreshBtn.style.position = 'fixed';
refreshBtn.style.bottom = '20px';
refreshBtn.style.right = '20px';
refreshBtn.style.zIndex = '10000';
refreshBtn.style.padding = '8px 12px';
refreshBtn.style.background = '#444';
refreshBtn.style.color = '#fff';
refreshBtn.style.border = 'none';
refreshBtn.style.borderRadius = '5px';
refreshBtn.style.cursor = 'pointer';
refreshBtn.style.boxShadow = '0 2px 6px rgba(0,0,0,0.3)';
document.body.appendChild(refreshBtn);

// On manual refresh, insert cached messages
refreshBtn.addEventListener('click', () => {
    if (!backgroundMessageCache.length) {
        alert('No new messages to display.');
        return;
    }

    let newFrame = document.getElementById(newMessageFrameId);
    if (!newFrame) {
        newFrame = document.createElement('div');
        newFrame.id = newMessageFrameId;
        newFrame.style.margin = '20px';
        newFrame.style.padding = '15px';
        newFrame.style.border = '2px solid #ccc';
        newFrame.style.borderRadius = '6px';
        newFrame.style.background = '#1e1e1e';
        newFrame.style.color = '#fff';
        newFrame.innerHTML = '<h3>New Messages</h3>';
        document.body.appendChild(newFrame);
    }

    backgroundMessageCache.forEach(msg => {
        const msgNode = renderMessageNode(msg); // <- needs to exist or be defined
        newFrame.appendChild(msgNode);
    });

    backgroundMessageCache = [];
});


// === Unload Video on Scroll Out ===
const videoObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
        const video = entry.target;
        if (!entry.isIntersecting) {
            video.pause();
            video.removeAttribute('src');
            video.load();
        } else {
            const src = video.dataset.src;
            if (src && !video.src) {
                video.src = src;
                video.load();
            }
        }
    });
}, { threshold: 0.01 });

function observeVideoUnload(video) {
    video.dataset.src = video.src;
    videoObserver.observe(video);
}

})();



// === Twitter Malformed Embed Fix ===
document.querySelectorAll(".tweet-content-container").forEach(container => {
  if (container && container.innerHTML.includes("https://x.com/")) {
    // Remove malformed embed text starting with "https://x.com/" and ending at LAST ">"
    container.innerHTML = container.innerHTML.replace(
      /https:\/\/x\.com\/[^>]+?>/g,
      ""
    );

    // Optional: if widget exists, retain only that
    const widget = container.querySelector(".twitter-widget-target");
    if (widget) {
      container.innerHTML = widget.outerHTML;
    }
  }
});
