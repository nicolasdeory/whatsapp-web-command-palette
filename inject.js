(function () {
    console.log("Inject script started");

    function waitForRequire(callback) {
        if (window.require) {
            console.log("window.require is available");
            callback(window.require);
        }
    }

    function initializeExtension(require) {
        console.log("Initializing extension");

        // New ranking function
        function rankMatch(query, item, originalIndex) {
            const normalizeString = (str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
            const normalizedItem = normalizeString(item);
            const normalizedQuery = normalizeString(query);

            if (!normalizedItem.includes(normalizedQuery[0])) return -1; // Early exit if first letter doesn't match

            let score = 0;
            let consecutiveMatches = 0;
            let lastMatchIndex = -1;

            for (let i = 0; i < normalizedQuery.length; i++) {
                const index = normalizedItem.indexOf(normalizedQuery[i], lastMatchIndex + 1);
                if (index === -1) return -1; // If any character is not found, return -1
                score += 1;
                if (index === lastMatchIndex + 1) {
                    consecutiveMatches++;
                    score += consecutiveMatches * 2; // Bonus for consecutive matches
                } else {
                    consecutiveMatches = 0;
                }
                lastMatchIndex = index;
            }

            // Bonus for matching at the start of the item
            if (normalizedItem.startsWith(normalizedQuery)) {
                score += 10;
            }

            // Adjust score based on string length (favor longer strings)
            score += normalizedItem.length * 0.1;

            // Prioritize original index
            score += (1000 - originalIndex) * 0.1;

            return score;
        }

        function processMessage(msg) {
            return {
                body: msg.type === 'chat' ? msg.body.replace(/</g, '&lt;').replace(/>/g, '&gt;') : `&lt;${msg.type}&gt;`,
                fromMe: !!msg.id.fromMe,
                authorName: msg.id.fromMe ? null : (msg.senderObj?.name ?? msg.pushname ?? 'Unknown')
            };
        }

        function enrichChatData(chat, index) {
            const unreadCount = chat.unreadCount;
            console.log(chat.msgs._models);
            const lastmsgs = chat.msgs?._models
                ?.slice(-15)
                .filter(msg => msg.type !== 'e2e_notification' && msg.type !== 'gp2')
                .map(processMessage) || [];

            return {
                original: chat.formattedTitle,
                highlighted: chat.formattedTitle,
                unreadCount,
                lastmsgs,
                chat,
                index
            };
        }

        function getInitialResults() {
            return window.Store.Chat._models
                .filter(chat => chat.unreadCount > 0)
                .sort((a, b) => b.unreadCount - a.unreadCount)
                .slice(0, 10)
                .map((chat, index) => enrichChatData(chat, index));
        }

        const fuzzySearch = (query, items) => {
            const results = items.map((item, index) => {
                const score = rankMatch(query, item.chat.formattedTitle, index);
                if (score <= 0) return null;

                let highlighted = '';
                let lastIndex = 0;
                const normalizedItem = item.chat.formattedTitle.toLowerCase();
                const normalizedQuery = query.toLowerCase();

                for (const char of normalizedQuery) {
                    const index = normalizedItem.indexOf(char, lastIndex);
                    if (index === -1) break;
                    highlighted += item.chat.formattedTitle.slice(lastIndex, index);
                    highlighted += `<mark>${item.chat.formattedTitle[index]}</mark>`;
                    lastIndex = index + 1;
                }
                highlighted += item.chat.formattedTitle.slice(lastIndex);

                const enrichedData = enrichChatData(item.chat, index);
                return { ...enrichedData, highlighted, score };
            }).filter(Boolean);

            // Sort by score, then by original index if scores are equal
            results.sort((a, b) => b.score - a.score || a.index - b.index);

            return results.slice(0, 15);
        };

        function switchToChat(chat) {
            console.log('Switching to chat:', chat.formattedTitle);
            window.Store.Cmd.openChatAt(chat);
            closeCommandPalette();
        }

        function closeCommandPalette() {
            const palette = document.getElementById('wa-command-palette');
            palette.classList.remove('active');
            document.getElementById('wa-search-input').value = '';
            document.getElementById('wa-search-results').innerHTML = '';
            hideChatPreview();
        }

        function createCommandPalette() {
            console.log("Creating command palette");
            const palette = document.createElement('div');
            palette.id = 'wa-command-palette';
            palette.innerHTML = `
        <input type="text" id="wa-search-input" placeholder="Search chats..." autocomplete="off">
        <ul id="wa-search-results"></ul>
        <div id="wa-chat-preview" style="display: none;"></div>
      `;
            document.body.appendChild(palette);

            const input = document.getElementById('wa-search-input');
            const resultsList = document.getElementById('wa-search-results');
            const chatPreview = document.getElementById('wa-chat-preview');
            let selectedIndex = 0;
            let results = [];

            // Function to update results list
            function updateResultsList(results) {
                resultsList.innerHTML = results.map((result, index) => {
                    return `
                        <li data-index="${index}">
                            <div class="result-item">
                                <div class="profile-pic" data-jid="${result.chat.id._serialized}"></div>
                                <div class="result-text">
                                    ${result.highlighted}
                                    ${result.unreadCount > 0 ? `<span class="unread-badge">${result.unreadCount}</span>` : ''}
                                </div>
                            </div>
                        </li>
                    `;
                }).join('');

                // Fetch profile pictures after rendering the list
                results.forEach(async (result, index) => {
                    await fetchProfilePic(result.chat.id, index);
                });

                selectedIndex = 0;
                updateSelectedItem();
                showChatPreviewForSelectedItem();
            }

            input.addEventListener('input', () => {
                const query = input.value;
                const chats = window.Store.Chat._models.map(chat => ({ chat }));
                results = fuzzySearch(query, chats);
                updateResultsList(results);

                // Hide preview if there are no results
                if (results.length === 0) {
                    hideChatPreview();
                }
            });

            resultsList.addEventListener('click', (e) => {
                const listItem = e.target.closest('li');
                if (listItem) {
                    const index = parseInt(listItem.dataset.index);
                    selectedIndex = index;
                    updateSelectedItem();
                    showChatPreview(results[index]);
                    switchToChat(results[index].chat);
                }
            });

            resultsList.addEventListener('mouseover', (e) => {
                if (e.target.tagName === 'LI') {
                    const index = parseInt(e.target.dataset.index);
                    selectedIndex = index;
                    updateSelectedItem();
                    showChatPreview(results[index]);
                }
            });

            document.addEventListener('keydown', (e) => {
                if (!palette.classList.contains('active')) return;

                const items = resultsList.querySelectorAll('li');

                switch (e.key) {
                    case 'ArrowUp':
                        e.preventDefault();
                        selectedIndex = (selectedIndex - 1 + items.length) % items.length;
                        updateSelectedItem();
                        showChatPreview(results[selectedIndex]);
                        break;
                    case 'ArrowDown':
                        e.preventDefault();
                        selectedIndex = (selectedIndex + 1) % items.length;
                        updateSelectedItem();
                        showChatPreview(results[selectedIndex]);
                        break;
                    case 'Enter':
                        if (items.length > 0) {
                            switchToChat(results[selectedIndex].chat);
                        }
                        break;
                    case 'Escape':
                        palette.classList.remove('active');
                        break;
                }

                updateSelectedItem();
                showChatPreviewForSelectedItem(); // Replace the existing showChatPreview call with this
                if (items.length > 0) {
                    showChatPreview(results[selectedIndex]);
                }
            });

            function updateSelectedItem() {
                const items = resultsList.querySelectorAll('li');
                items.forEach((item, index) => {
                    item.classList.toggle('selected', index === selectedIndex);
                });

                // Scroll the selected item into view
                const selectedItem = items[selectedIndex];
                if (selectedItem) {
                    selectedItem.scrollIntoView({ block: 'nearest', behavior: 'instant' });
                }
            }

            function resetChatPreview() {
                chatPreview.innerHTML = '';
                chatPreview.style.display = 'none';
            }

            function getSpeakerName(msg, isGroup) {
                if (msg.fromMe) return 'You';
                if (!isGroup) return 'Them';
                return msg.authorName;
            }

            async function showChatPreview(result) {
                let currentSpeaker = null;
                chatPreview.innerHTML = `<h3>${result.original}</h3><div id="messages-container"></div>`;
                chatPreview.style.display = 'block';

                const messagesContainer = document.getElementById('messages-container');

                // Check if we need to fetch more messages
                if (result.lastmsgs.length < 5 && !result.chat.fetchedEarlierMessages) {
                    const earlierMessages = await fetchEarlierMessages(result.chat);
                    result.lastmsgs = [...earlierMessages, ...result.lastmsgs];
                    result.chat.fetchedEarlierMessages = true;
                }

                const isGroup = result.chat.isGroup;

                result.lastmsgs.forEach(msg => {
                    let output = '';
                    const speaker = getSpeakerName(msg, isGroup);                 
                    
                    if (speaker !== currentSpeaker) {
                        currentSpeaker = speaker;
                        output += `<p style="text-align: ${msg.fromMe ? 'right' : 'left'};"><strong style="color: ${!msg.fromMe ? 'var(--focus)' : 'inherit'};">${speaker}</strong></p>`;
                    }
                    output += `<p style="text-align: ${msg.fromMe ? 'right' : 'left'};">${msg.body || ''}</p>`;
                    messagesContainer.innerHTML += output;
                });

                // Use requestAnimationFrame to ensure the DOM has updated before scrolling
                requestAnimationFrame(() => {
                    scrollChatPreviewToBottom();
                });
            }

            // Add this new function to scroll the chat preview to the bottom
            function scrollChatPreviewToBottom() {
                const messagesContainer = document.getElementById('wa-chat-preview');
                if (messagesContainer) {
                    messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'instant' });
                }
            }

            async function fetchEarlierMessages(chat) {
                return new Promise((resolve) => {
                    window.Store.ConversationMsgs.loadEarlierMsgs(chat).then(loadedMessages => {
                        if (!loadedMessages || !loadedMessages.length) {
                            resolve([]);
                            return;
                        }

                        const messages = loadedMessages
                            .filter(msg => !msg.isNotification)
                            .map(processMessage);

                        resolve(messages.slice(-15)); // Limit to 15 messages
                    });
                });
            }

            // Add the Ctrl+K shortcut to open/close the palette
            document.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                    e.preventDefault();
                    palette.classList.toggle('active');
                    if (palette.classList.contains('active')) {
                        input.focus();
                        input.value = '';
                        results = getInitialResults(); // Get initial results
                        updateResultsList(results); // Update the list with initial results
                        selectedIndex = 0;
                        updateSelectedItem();
                        showChatPreviewForSelectedItem();
                    }
                }
            });

            // Add this new event listener
            document.addEventListener('click', (e) => {
                const palette = document.getElementById('wa-command-palette');
                const chatPreview = document.getElementById('wa-chat-preview');
                if (!palette.contains(e.target) && !chatPreview.contains(e.target)) {
                    palette.classList.remove('active');
                    resetChatPreview();
                    selectedIndex = 0;
                    updateSelectedItem();
                }
            });

            // Add this new function to show the chat preview
            function showChatPreviewForSelectedItem() {
                if (results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length) {
                    showChatPreview(results[selectedIndex]);
                } else {
                    resetChatPreview();
                }
            }

            function resetChatPreview() {
                const chatPreview = document.getElementById('wa-chat-preview');
                chatPreview.style.display = 'none';
            }
        }

        // Initialize WhatsApp Web client and set up Store
        console.log("Initializing WhatsApp Web client");
        window.Store = Object.assign({}, window.require('WAWebCollections'));
        window.Store.ConversationMsgs = Object.assign({}, window.require('WAWebChatLoadMessages'));
        window.Store.Cmd = window.require('WAWebCmd').Cmd;
        createCommandPalette();
    }

    // Wait for the document to be fully loaded
    if (document.readyState === 'complete') {
        waitForRequire(initializeExtension);
    } else {
        window.addEventListener('load', () => waitForRequire(initializeExtension));
    }
})();

async function fetchProfilePic(jid, index) {
    const pic = await window.Store.ProfilePicThumb.find(jid)
    if (pic && pic.img) {
        const imgElement = document.querySelector(`li[data-index="${index}"] .profile-pic`);
        if (imgElement) {
            imgElement.style.backgroundImage = `url(${pic.img})`;
        }
    }
}