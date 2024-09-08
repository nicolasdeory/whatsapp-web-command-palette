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

        function getName(msg) {
            return msg.id.fromMe ? 'You' : (msg.senderObj?.name ?? msg.senderObj?.pushname ?? msg.pushname ?? 'Unknown');
        }

        function processMessage(msg) {
            return {
                body: msg.type === 'chat' ? msg.body.replace(/</g, '&lt;').replace(/>/g, '&gt;') : `&lt;${msg.type}&gt;`,
                fromMe: !!msg.id.fromMe,
                authorName: getName(msg)
            };
        }

        function enrichChatData(chat, index) {
            const unreadCount = chat.unreadCount;
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



        function createCommandPalette() {
            function switchToChat(chat) {
                console.log('Switching to chat:', chat.formattedTitle);
                window.Store.Cmd.openChatAt(chat);
                closeCommandPalette();
            }

            // Add this new function
            function hideChatPreview() {
                const chatPreview = document.getElementById('wa-chat-preview');
                if (chatPreview) {
                    chatPreview.style.display = 'none';
                }
            }

            console.log("Creating command palette");
            const palette = document.createElement('div');
            palette.id = 'wa-command-palette';
            palette.innerHTML = `
        <div id="wa-search-container">
            <input type="text" id="wa-search-input" placeholder="Search chats..." autocomplete="off">
            <div id="wa-chat-badge" style="display: none;"></div>
        </div>
        <ul id="wa-search-results"></ul>
        <div id="wa-chat-preview" style="display: none;"></div>
      `;
            document.body.appendChild(palette);

            const input = document.getElementById('wa-search-input');
            const resultsList = document.getElementById('wa-search-results');
            const chatPreview = document.getElementById('wa-chat-preview');
            const chatBadge = document.getElementById('wa-chat-badge');
            let selectedIndex = 0;
            let results = [];
            let isSearchingChat = false;
            let currentChat = null;

            function isPaletteActive() {
                return palette.classList.contains('active');
            }

            function closeCommandPalette() {
                const palette = document.getElementById('wa-command-palette');
                palette.classList.remove('active');
                document.getElementById('wa-search-input').value = '';
                document.getElementById('wa-search-results').innerHTML = '';
                hideChatPreview();
                disableTextSearchMode();
            }

            // Function to update results list
            function updateResultsList(results) {
                resultsList.innerHTML = results.map((result, index) => {
                    if (isSearchingChat) {
                        return `
                            <li data-index="${index}">
                                <div class="result-item">
                                    <div class="result-text">${result.highlighted}</div>
                                </div>
                            </li>
                        `;
                    } else {
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
                    }
                }).join('');

                if (!isSearchingChat) {
                    results.forEach(async (result, index) => {
                        await fetchProfilePic(result.chat.id, index);
                    });
                }

                selectedIndex = 0;
                updateSelectedItem();
                showChatPreviewForSelectedItem();
            }

            // Add this debounce function near the top of your script
            function debounce(func, wait) {
                let timeout;
                return function executedFunction(...args) {
                    const later = () => {
                        clearTimeout(timeout);
                        func(...args);
                    };
                    clearTimeout(timeout);
                    timeout = setTimeout(later, wait);
                };
            }

            // Modify the input event listener
            input.addEventListener('input', () => {
                const query = input.value;
                // if (isSearchingChat && query === '') {
                //     disableTextSearchMode();
                //     results = getInitialResults();
                //     updateResultsList(results);
                // } else 
                if (isSearchingChat) {
                    debouncedSearchChatMessages(query);
                } else {
                    const chats = window.Store.Chat._models.map(chat => ({ chat }));
                    results = fuzzySearch(query, chats);
                    updateResultsList(results);
                }
            });

            // Add this new debounced function for searching chat messages
            const debouncedSearchChatMessages = debounce(async (query) => {
                if (!currentChat) return;

                results = [];

                if (query.toLowerCase().startsWith('p')) {
                    const isPinned = currentChat.pin;
                    results.push({
                        original: isPinned ? 'Unpin chat' : 'Pin chat',
                        highlighted: isPinned ? '<strong>Unpin chat</strong>' : '<strong>Pin chat</strong>',
                        chat: currentChat,
                        command: isPinned ? 'unpin' : 'pin',
                        index: 0
                    });
                }

                if (query.toLowerCase().startsWith('i') || query.toLowerCase().startsWith('o')) {
                    results.push({
                        original: 'Open chat info',
                        highlighted: '<strong>Open chat info</strong>',
                        chat: currentChat,
                        command: 'openInfo',
                        index: results.length
                    });
                }

                const { messages } = await window.Store.Msg.search(query, 1, 50, currentChat.id);
                results = results.concat(messages.map((msg, index) => ({
                    original: msg.body,
                    highlighted: highlightQuery(msg.type === 'chat' ? msg.body : msg.caption, query),
                    msg,
                    chat: currentChat,
                    index: results.length > 0 ? results.length + 1 : 0  // Offset by 1 to account for potential pin/unpin result
                })));

                updateResultsList(results);
            }, 50); // 50ms delay

            function handleRecordSelection(index) {
                    if (results[index].command) {
                        if (results[index].command === 'pin') {
                            window.Store.Cmd.pinChat(results[index].chat, true);
                        } else if (results[index].command === 'unpin') {
                            window.Store.Cmd.pinChat(results[index].chat, false);
                        } else if (results[index].command === 'openInfo') {
                            window.Store.Cmd.openProfile(results[index].chat);
                        }
                        closeCommandPalette();
                    } else if (isSearchingChat) {
                        jumpToMessage(results[index].chat, results[index].msg);
                    } else {
                        switchToChat(results[index].chat);
                    }
            }

            resultsList.addEventListener('click', (e) => {
                const listItem = e.target.closest('li');
                if (listItem) {
                    const index = parseInt(listItem.dataset.index);
                    selectedIndex = index;
                    updateSelectedItem();
                    showChatPreview(results[index]);
                    handleRecordSelection(index);
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
                            handleRecordSelection(selectedIndex);
                        }
                        break;
                    case 'Escape':
                        e.preventDefault();
                        if (isSearchingChat) {
                            disableTextSearchMode();
                            results = getInitialResults();
                            updateResultsList(results);
                        } else {
                            closeCommandPalette();
                        }
                        break;
                }

                if (isPaletteActive()) {
                    updateSelectedItem();
                    showChatPreviewForSelectedItem();
                    if (items.length > 0) {
                        showChatPreview(results[selectedIndex]);
                    }
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
                return msg.authorName ?? msg.author;
            }

            async function showChatPreview(result) {
                if (!result || result?.command) return;
                let currentSpeaker = null;
                chatPreview.innerHTML = `<h3>${isSearchingChat ? currentChat.formattedTitle : result.original}</h3><div id="messages-container"></div>`;
                chatPreview.style.display = 'block';

                const messagesContainer = document.getElementById('messages-container');

                if (isSearchingChat) {
                    // Display the single message for search results
                    const msg = result.msg;
                    if (!result.msg) return;
                    const speaker = getName(msg);
                    let output = `<p style="text-align: ${msg.fromMe ? 'right' : 'left'};"><strong style="color: ${!msg.fromMe ? 'var(--focus)' : 'inherit'};">${speaker}</strong></p>`;
                    output += `<p style="text-align: ${msg.fromMe ? 'right' : 'left'};">${result.highlighted}</p>`;
                    messagesContainer.innerHTML = output;
                } else {
                    // Existing logic for chat preview
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
                }

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
                            .filter(msg => msg.type !== 'e2e_notification' && msg.type !== 'gp2')
                            .map(processMessage);

                        resolve(messages.slice(-15)); // Limit to 15 messages
                    });
                });
            }

            // Add the Ctrl+K shortcut to open/close the palette
            document.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                    e.preventDefault();
                    window.Store.Cmd.closeCommandPalette();
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

            // Add this new function
            function disableTextSearchMode() {
                isSearchingChat = false;
                currentChat = null;
                input.value = '';
                chatBadge.style.display = 'none';
                chatBadge.style.backgroundColor = ''; // Reset background color
                input.placeholder = 'Search chats...';
            }

            // Add this new event listener for the Tab key
            input.addEventListener('keydown', async (e) => {
                if (e.key === 'Tab') {
                    e.preventDefault();
                    if (!isSearchingChat) {
                        if (results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length) {
                            const selectedChat = results[selectedIndex].chat;
                            isSearchingChat = true;
                            currentChat = selectedChat;
                            chatBadge.textContent = `Searching ${selectedChat.formattedTitle}`;
                            chatBadge.style.display = 'block';
                            input.placeholder = 'Search messages...';
                            input.value = '';
                            await searchChatMessages('');
                        }
                    } else {
                        disableTextSearchMode();
                        results = getInitialResults();
                        updateResultsList(results);
                    }
                }
            });

            // Move the click outside handler inside createCommandPalette
            document.addEventListener('click', (e) => {
                if (!palette.contains(e.target) && !chatPreview.contains(e.target)) {
                    closeCommandPalette();
                    palette.classList.remove('active');
                    disableTextSearchMode();
                    results = getInitialResults();
                    updateResultsList(results);
                }
            });

            // Add this new function
            async function searchChatMessages(query) {
                if (!currentChat) return;

                const { messages } = await window.Store.Msg.search(query, 1, 50, currentChat.id);
                results = messages.map((msg, index) => ({
                    original: msg.body,
                    highlighted: highlightQuery(msg.type === 'chat' ? msg.body : msg.caption, query),
                    msg,
                    chat: currentChat,  // Add this line to include the chat object
                    index
                }));
                updateResultsList(results);
            }

            function highlightQuery(text, query) {
                if (!query) return text;
                const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(escapedQuery.split(/\s+/).join('|'), 'gi');
                return text.replace(regex, match => `<mark>${match}</mark>`);
            }

            // Add this new function
            async function jumpToMessage(chat, msg) {
                const searchContext = await window.Store.SearchContext(currentChat, msg);
                window.Store.Cmd.openChatAt(currentChat, searchContext);
                closeCommandPalette();
            }


        }

        // Initialize WhatsApp Web client and set up Store
        console.log("Initializing WhatsApp Web client");
        window.Store = Object.assign({}, window.require('WAWebCollections'));
        window.Store.ConversationMsgs = Object.assign({}, window.require('WAWebChatLoadMessages'));
        window.Store.Cmd = window.require('WAWebCmd').Cmd;
        window.Store.SearchContext = window.require('WAWebChatMessageSearch').getSearchContext;
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