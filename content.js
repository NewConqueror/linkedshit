let isMutating = false;
let bsWords = [];
let regexBS = null;
const regexEmoji = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
const strongPostContainerSelector = [
    '[data-urn^="urn:li:activity:"]',
    '[data-id^="urn:li:activity:"]',
    '[data-urn*="activity"]',
    '[data-id*="activity"]',
    '.occludable-update',
    'article',
    '[role="article"]'
].join(', ');

const weakPostClassHints = [
    'feed-shared-update-v2',
    'update-components-update-v2',
    'occludable-update',
    'fie-impression-container',
    'scaffold-finite-scroll__content'
];

const textProcessingScopeSelector = [
    'main',
    '[role="main"]',
    '.scaffold-layout__main',
    '.scaffold-finite-scroll__content',
    '.feed-shared-update-v2',
    '.update-components-update-v2',
    '.comments-comments-list',
    '.comments-comment-item'
].join(', ');

const ignoredProcessingSelector = [
    '.artdeco-toast-item',
    '[aria-hidden="true"]',
    '[data-test-id*="ad"]',
    '.ad-banner-container',
    '.bs-post-badge',
    '.bs-post-preview'
].join(', ');
const defaultScoreThreshold = 6;
const defaultCollapseMode = 'paragraph';

let scoreSettings = {
    enableScoring: true,
    scoreThreshold: defaultScoreThreshold,
    collapseMode: defaultCollapseMode
};

let scoreRefreshTimer = null;
let observerCycleCount = 0;
let observerWindowStart = Date.now();
let observerCooldownTimer = null;

const observerWindowMs = 2500;
const observerCycleLimit = 500;

// Türkçeye özel harf varyasyonlarını Regex karakter sınıflarına çeviren motor
function makeTurkishRegex(word) {
    let regexStr = "";
    for (let char of word) {
        let lower = char.toLocaleLowerCase('tr-TR');
        let upper = char.toLocaleUpperCase('tr-TR');
        
        // Klasik i/İ ve ı/I problemini kökten çözen eşleme
        if ("iİıI".includes(char)) {
            regexStr += "[iİıI]";
        } else if ("gGğĞ".includes(char)) {
            regexStr += "[gGğĞ]";
        } else if ("uUüÜ".includes(char)) {
            regexStr += "[uUüÜ]";
        } else if ("sSşŞ".includes(char)) {
            regexStr += "[sSşŞ]";
        } else if ("oOöÖ".includes(char)) {
            regexStr += "[oOöÖ]";
        } else if ("cCcÇ".includes(char)) {
            regexStr += "[cCcÇ]";
        } else {
            // Standart ASCII harfler (A-Z)
            if (lower !== upper) {
                regexStr += `[${lower}${upper}]`;
            } else {
                regexStr += char; // Boşluk, tire veya sayıysa direkt ekle
            }
        }
    }
    return regexStr;
}


function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function updateRegex(words) {
    if (!words || words.length === 0) {
        regexBS = null;
        return;
    }

    // 1. Kullanıcının kelimelerini aşılmaz Türkçe Regex matrisine çevirmeden önce escape ediyoruz
    const safeWords = words.map(escapeRegExp);
    const turkishWords = safeWords.map(makeTurkishRegex);
    const combined = turkishWords.join('|');

    // 2. Kelimenin herhangi bir yerde geçmesini sağlayacak şekilde (kısıtlamasız yakalama)
    try {
        regexBS = new RegExp(`(?<![a-zıİğĞüÜşŞçÇöÖ])(${combined})(?![a-zıİğĞüÜşŞçÇöÖ])`, 'giu');
    } catch (e) {
        console.error("Critical: Failed to compile BS Filter regex.", e);
        regexBS = null;
    }
}

// XSS koruması: Text Node'dan HTML'e geçerken kırılmaları önler
function escapeHTML(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizeScoreThreshold(value) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return defaultScoreThreshold;
    return Math.min(20, Math.max(1, parsed));
}

function updateScoreSettings(state) {
    scoreSettings.enableScoring = state.enableScoring !== false;
    scoreSettings.scoreThreshold = normalizeScoreThreshold(state.scoreThreshold);
    scoreSettings.collapseMode = state.collapseMode === 'classic' ? 'classic' : defaultCollapseMode;
}

function getScoreLevel(score, threshold) {
    if (score >= threshold * 2) return 'high';
    if (score >= threshold) return 'medium';
    return 'low';
}

function getScoreLevelLabel(level) {
    if (level === 'high') return 'Yuksek';
    if (level === 'medium') return 'Orta';
    return 'Dusuk';
}

function getDirectBadge(post) {
    return Array.from(post.children).find((child) => child.classList && child.classList.contains('bs-post-badge')) || null;
}

function getClassNameSafe(element) {
    if (!element) return '';
    return typeof element.className === 'string' ? element.className : '';
}

function getElementFromNode(node) {
    if (!node) return null;

    if (node.nodeType === Node.TEXT_NODE) {
        return node.parentElement || null;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
        return node;
    }

    return null;
}

function isWithinProcessingScope(nodeOrElement) {
    const element = getElementFromNode(nodeOrElement);
    if (!element || !element.closest) return false;
    return !!element.closest(textProcessingScopeSelector);
}

function isInsideIgnoredContainer(nodeOrElement) {
    const element = getElementFromNode(nodeOrElement);
    if (!element || !element.closest) return false;
    return !!element.closest(ignoredProcessingSelector);
}

function isStrongPostContainer(element) {
    return !!(element && element.matches && element.matches(strongPostContainerSelector));
}

function isWeakPostContainer(element) {
    if (!element) return false;

    const className = getClassNameSafe(element);
    if (weakPostClassHints.some((hint) => className.includes(hint))) {
        return true;
    }

    const dataUrn = (element.getAttribute && element.getAttribute('data-urn')) || '';
    const dataId = (element.getAttribute && element.getAttribute('data-id')) || '';
    return dataUrn.includes('activity') || dataId.includes('activity');
}

function getDirectPreview(post) {
    return Array.from(post.children).find((child) => child.classList && child.classList.contains('bs-post-preview')) || null;
}

function clearCollapsedPreview(post) {
    const preview = getDirectPreview(post);
    if (preview) preview.remove();
}

function truncateParagraph(text, maxLength = 320) {
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength).trim()}...`;
}

function extractPostParagraph(post) {
    const paragraphCandidates = post.querySelectorAll(
        '.update-components-text, .feed-shared-update-v2__description, .feed-shared-inline-show-more-text, p, div[dir], span[dir]'
    );

    for (const candidate of paragraphCandidates) {
        if (candidate.closest('.bs-post-badge') || candidate.closest('.bs-post-preview')) {
            continue;
        }

        const text = (candidate.textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length >= 30) {
            return truncateParagraph(text);
        }
    }

    const walker = document.createTreeWalker(post, NodeFilter.SHOW_TEXT, {
        acceptNode: function(node) {
            const parent = node.parentNode;
            if (!parent) return NodeFilter.FILTER_REJECT;

            if (
                ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.nodeName) ||
                parent.closest('.bs-post-badge') ||
                parent.closest('.bs-post-preview')
            ) {
                return NodeFilter.FILTER_REJECT;
            }

            const value = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
            if (!value) return NodeFilter.FILTER_REJECT;

            return NodeFilter.FILTER_ACCEPT;
        }
    });

    const chunks = [];
    let totalLength = 0;
    let currentNode = walker.nextNode();

    while (currentNode && totalLength < 260) {
        const value = currentNode.nodeValue.replace(/\s+/g, ' ').trim();
        if (value) {
            chunks.push(value);
            totalLength += value.length + 1;
        }
        currentNode = walker.nextNode();
    }

    const merged = chunks.join(' ').replace(/\s+/g, ' ').trim();
    if (!merged) return 'Icerik daraltildi';

    return truncateParagraph(merged);
}

function upsertCollapsedPreview(post) {
    const paragraphText = extractPostParagraph(post);
    let preview = getDirectPreview(post);

    if (!preview) {
        preview = document.createElement('div');
        preview.className = 'bs-post-preview';
        post.prepend(preview);
    }

    preview.textContent = paragraphText;
}

function findPostContainer(element) {
    if (!element) return null;

    let current = element;
    let weakCandidate = null;

    while (current && current !== document.body) {
        if (isStrongPostContainer(current)) {
            return current;
        }

        if (!weakCandidate && isWeakPostContainer(current)) {
            weakCandidate = current;
        }

        current = current.parentElement;
    }

    if (weakCandidate) {
        return weakCandidate;
    }

    if (element.closest) {
        return element.closest('li, article, [role="article"], [data-urn], [data-id]');
    }

    return null;
}

function findFallbackScorableContainer(element) {
    let current = element;

    while (current && current !== document.body) {
        if (['LI', 'ARTICLE', 'SECTION', 'DIV'].includes(current.tagName)) {
            const textLength = (current.textContent || '').replace(/\s+/g, ' ').trim().length;
            if (textLength >= 80) {
                return current;
            }
        }

        current = current.parentElement;
    }

    return element && element.parentElement ? element.parentElement : null;
}

function clearPostScoring() {
    document.querySelectorAll('.bs-post-badge').forEach((badge) => badge.remove());
    document.querySelectorAll('.bs-post-preview').forEach((preview) => preview.remove());
    document.querySelectorAll('.bs-scored-post, .bs-collapsed-post').forEach((post) => {
        post.classList.remove('bs-scored-post', 'bs-collapsed-post');
        post.removeAttribute('data-bs-score');
        delete post.dataset.bsForceOpen;
    });
}

function upsertPostBadge(post, score) {
    const isCollapsible = score >= scoreSettings.scoreThreshold;
    const level = getScoreLevel(score, scoreSettings.scoreThreshold);

    if (!isCollapsible) {
        delete post.dataset.bsForceOpen;
    }

    const shouldCollapse = isCollapsible && post.dataset.bsForceOpen !== '1';
    post.classList.add('bs-scored-post');
    post.setAttribute('data-bs-score', String(score));
    post.classList.toggle('bs-collapsed-post', shouldCollapse);

    let badge = getDirectBadge(post);
    if (!badge) {
        badge = document.createElement('div');
        badge.className = 'bs-post-badge';
        post.prepend(badge);
    }

    badge.classList.remove('is-low', 'is-medium', 'is-high');
    badge.classList.add(`is-${level}`);

    badge.textContent = '';

    const label = document.createElement('span');
    label.className = 'bs-post-score-label';
    label.textContent = `BS Skoru: ${score} • ${getScoreLevelLabel(level)}`;
    badge.appendChild(label);

    if (scoreSettings.collapseMode === 'paragraph' && shouldCollapse) {
        upsertCollapsedPreview(post);
    } else {
        clearCollapsedPreview(post);
    }

    if (!isCollapsible) return;

    const toggleButton = document.createElement('button');
    toggleButton.type = 'button';
    toggleButton.className = 'bs-post-toggle';
    toggleButton.textContent = shouldCollapse ? 'Goster' : 'Daralt';
    toggleButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        const currentlyCollapsed = post.classList.contains('bs-collapsed-post');
        if (currentlyCollapsed) {
            post.classList.remove('bs-collapsed-post');
            post.dataset.bsForceOpen = '1';
            toggleButton.textContent = 'Daralt';
            clearCollapsedPreview(post);
        } else {
            post.classList.add('bs-collapsed-post');
            delete post.dataset.bsForceOpen;
            toggleButton.textContent = 'Goster';
            if (scoreSettings.collapseMode === 'paragraph') {
                upsertCollapsedPreview(post);
            }
        }
    });

    badge.appendChild(toggleButton);
}

function applyPostScoring() {
    if (!document.body) return;

    if (!scoreSettings.enableScoring) {
        clearPostScoring();
        return;
    }

    const postScores = new Map();
    document.querySelectorAll('span.bs-main-wrapper').forEach((wrapper) => {
        let post = findPostContainer(wrapper.parentElement || wrapper);
        if (!post && wrapper.closest) {
            post = wrapper.closest('li, article, [role="article"], [data-urn], [data-id], .fie-impression-container');
        }

        if (!post) {
            post = findFallbackScorableContainer(wrapper.parentElement || wrapper);
        }

        if (!post) return;

        if (['SPAN', 'P', 'A'].includes(post.tagName) && post.parentElement) {
            post = post.parentElement;
        }

        const bsCount = wrapper.querySelectorAll('span.bs-keyword').length;
        const emojiCount = wrapper.querySelectorAll('span.emoji-wrapper').length;
        const nodeScore = bsCount + emojiCount;
        if (!nodeScore) return;

        postScores.set(post, (postScores.get(post) || 0) + nodeScore);
    });

    document.querySelectorAll('.bs-scored-post').forEach((post) => {
        if (postScores.has(post)) return;
        post.classList.remove('bs-scored-post', 'bs-collapsed-post');
        post.removeAttribute('data-bs-score');
        delete post.dataset.bsForceOpen;
        clearCollapsedPreview(post);

        const badge = getDirectBadge(post);
        if (badge) badge.remove();
    });

    postScores.forEach((score, post) => {
        upsertPostBadge(post, score);
    });
}

function schedulePostScoring() {
    clearTimeout(scoreRefreshTimer);
    scoreRefreshTimer = setTimeout(() => {
        applyPostScoring();
    }, 150);
}

function getProcessingRoots() {
    const roots = Array.from(document.querySelectorAll(textProcessingScopeSelector));
    if (roots.length > 0) return roots;
    return document.body ? [document.body] : [];
}

function resetObserverCounterWindow() {
    observerCycleCount = 0;
    observerWindowStart = Date.now();
}

function isObserverOverloaded() {
    const now = Date.now();
    if (now - observerWindowStart > observerWindowMs) {
        resetObserverCounterWindow();
    }

    observerCycleCount += 1;
    return observerCycleCount > observerCycleLimit;
}

function pauseObserverTemporarily() {
    observer.disconnect();
    clearTimeout(observerCooldownTimer);
    observerCooldownTimer = setTimeout(() => {
        resetObserverCounterWindow();
        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
        }
    }, 800);
}

// ÇÖZÜM: DOM'u %100 Orijinal Haline Getiren Gelişmiş Temizleyici
function restoreDOM() {
    const wrappers = document.querySelectorAll('span.bs-main-wrapper');
    wrappers.forEach(wrapper => {
        // 1. Önce bu cümlenin içindeki emojileri orijinal haline (data-orig) döndür
        const emojis = wrapper.querySelectorAll('span.emoji-wrapper');
        emojis.forEach(emp => {
            const originalEmoji = emp.getAttribute('data-orig');
            emp.parentNode.replaceChild(document.createTextNode(originalEmoji), emp);
        });

        // 2. Değiştirilen BS kelimelerini orijinal haline (data-orig) döndür
        const keywords = wrapper.querySelectorAll('span.bs-keyword');
        keywords.forEach(kw => {
            const originalKeyword = kw.getAttribute('data-orig');
            kw.parentNode.replaceChild(document.createTextNode(originalKeyword), kw);
        });

        // 3. Artık wrapper'ın içindeki tüm metin (textContent) %100 orijinal halinde. 
        // Wrapper'ı yok et ve yerine saf metin düğümü koy.
        const originalTextNode = document.createTextNode(wrapper.textContent);
        wrapper.parentNode.replaceChild(originalTextNode, wrapper);
    });

    clearPostScoring();
}

function processTextNode(node) {
    if (!node.nodeValue || !node.parentNode) return;
    if (!isWithinProcessingScope(node)) return;
    if (isInsideIgnoredContainer(node)) return;
    
    let originalText = node.nodeValue;
    
    // İşlem yapmaya gerek var mı diye kontrol et (Performans için)
    let hasEmoji = originalText.match(regexEmoji);
    let hasBS = regexBS ? originalText.match(regexBS) : false;
    
    if (!hasEmoji && !hasBS) return; // İkisi de yoksa pas geç

    // Güvenli HTML string'i oluştur
    let processedHTML = escapeHTML(originalText);
    
    // 1. Emojileri stateful span'ler ile değiştir
    if (hasEmoji) {
        // Orijinal emojiyi data-orig içine saklıyoruz
        processedHTML = processedHTML.replace(regexEmoji, '<span class="emoji-wrapper" data-orig="$&">🤡</span>');
    }
    
    // 2. BS kelimelerini değiştir
    if (hasBS) {
        processedHTML = processedHTML.replace(regexBS, '<span class="bs-keyword" data-orig="$&">🔴</span>');
    }

    // Tek bir ana kapsayıcı (wrapper) oluştur ve DOM'a bas
    let span = document.createElement('span');
    span.className = 'bs-main-wrapper';
    span.innerHTML = processedHTML;
    node.parentNode.replaceChild(span, node);
}

function walkAndProcess(rootElement) {
    const walker = document.createTreeWalker(rootElement, NodeFilter.SHOW_TEXT, {
        acceptNode: function(node) {
            const parent = node.parentNode;
            if (!parent) return NodeFilter.FILTER_REJECT;
            // PRECISE FIX: Reject contenteditable elements to prevent React/Slate.js corruption
            if (
                ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT'].includes(parent.nodeName) || 
                parent.isContentEditable || 
                parent.closest('[contenteditable="true"]') ||
                parent.closest('[contenteditable="plaintext-only"]') ||
                parent.closest('.bs-post-badge') ||
                parent.closest('.bs-post-preview')
            ) {
                return NodeFilter.FILTER_REJECT;
            }

            if (!isWithinProcessingScope(parent) || isInsideIgnoredContainer(parent)) {
                return NodeFilter.FILTER_REJECT;
            }

            // Kendi yarattığımız sistemin içine girmeyi reddediyoruz
            if (parent.classList && (parent.classList.contains('bs-keyword') || parent.classList.contains('bs-main-wrapper') || parent.classList.contains('emoji-wrapper'))) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        }
    });

    // PRECISE FIX: O(1) Memory Footprint via Generator/Direct Processing
    let currentNode;
    let nextNode = walker.nextNode();
    while (nextNode) {
        currentNode = nextNode;
        nextNode = walker.nextNode(); // grab the next BEFORE processing/replacing the current node
        processTextNode(currentNode);
    }
}

const observer = new MutationObserver((mutations) => {
    if (isMutating) return;
    if (isObserverOverloaded()) {
        pauseObserverTemporarily();
        return;
    }
    
    isMutating = true;
    try {
        let hasRelevantMutations = false;

        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.classList && node.classList.contains('bs-post-badge')) return;
                    if (node.closest && node.closest('.bs-post-badge')) return;
                    if (node.classList && node.classList.contains('bs-post-preview')) return;
                    if (node.closest && node.closest('.bs-post-preview')) return;
                    if (!isWithinProcessingScope(node) || isInsideIgnoredContainer(node)) return;

                    walkAndProcess(node);
                    hasRelevantMutations = true;
                } else if (node.nodeType === Node.TEXT_NODE) {
                    if (node.parentElement && node.parentElement.closest('.bs-post-badge')) return;
                    if (node.parentElement && node.parentElement.closest('.bs-post-preview')) return;
                    if (!isWithinProcessingScope(node) || isInsideIgnoredContainer(node)) return;

                    processTextNode(node);
                    hasRelevantMutations = true;
                }
            });
        });

        if (hasRelevantMutations) {
            schedulePostScoring();
        }
    } catch (err) {
        console.error("DOM İşlem Hatası:", err);
    } finally {
        isMutating = false;
    }
});

chrome.storage.sync.get({
    isActive: true,
    bsWords: typeof allDefaultBSWords !== 'undefined' ? allDefaultBSWords : [],
    enableScoring: true,
    scoreThreshold: defaultScoreThreshold
}, (state) => {
    if (!state.isActive) return;

    updateScoreSettings(state);
    updateRegex(state.bsWords);
    
    // Sayfa yüklenirken latency toleransı
    setTimeout(() => {
        isMutating = true;
        getProcessingRoots().forEach((root) => walkAndProcess(root));
        isMutating = false;
        applyPostScoring();
    }, 2000);
    
    resetObserverCounterWindow();
    observer.observe(document.body, { childList: true, subtree: true });
});

// Real-time İletişim: Aç/Kapat ve Kelime Ekle/Çıkar
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "updateState" && request.state) {
        isMutating = true;
        updateScoreSettings(request.state);
        
        if (request.state.isActive === false) {
            observer.disconnect();
            clearTimeout(observerCooldownTimer);
            restoreDOM(); // Emojileri ve kelimeleri geri getir
            console.log("🛑 Motor durduruldu, orijinal DOM yüklendi.");
            isMutating = false;
        } else {
            updateRegex(request.state.bsWords);
            restoreDOM(); // Önce eski kalıntıları temizle
            getProcessingRoots().forEach((root) => walkAndProcess(root)); // Yeni kurallarla tekrar tara
            applyPostScoring();
            isMutating = false;
            resetObserverCounterWindow();
            observer.observe(document.body, { childList: true, subtree: true });
        }
    }
});