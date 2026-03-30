let isMutating = false;
let regexBSTest = null;
let regexBSReplace = null;
const regexEmojiTest = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
const regexEmojiReplace = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
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
let statsFlushTimer = null;
let isObserverRunning = false;
let isEngineActive = false;
let compiledWordsSignature = '';
let currentWordsSignature = '';

const weeklyStatsStorageKey = 'bsWeeklyStatsV1';
const maxSeenHashesPerWeek = 2500;
const maxTrackedWords = 300;
const statsFlushDelayMs = 1200;

let pendingStatsRecords = [];
let sessionReportedHashes = new Set();
let sessionWeekKey = '';
let scoredPostsCache = new Set();

const wrapperPostCache = new WeakMap();
const wrapperWordsCache = new WeakMap();
const postFingerprintCache = new WeakMap();

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

function normalizeWordList(words) {
    if (!Array.isArray(words)) return [];

    const deduped = [];
    const seen = new Set();

    words.forEach((word) => {
        const normalized = String(word || '').trim();
        if (!normalized) return;

        const key = normalized.toLocaleLowerCase('tr-TR');
        if (seen.has(key)) return;

        seen.add(key);
        deduped.push(normalized);
    });

    // Uzun ifadeleri öne almak regex alternation backtracking maliyetini azaltır.
    deduped.sort((a, b) => b.length - a.length);
    return deduped;
}

function getWordsSignature(words) {
    return normalizeWordList(words).join('\u0001');
}

function updateRegex(words) {
    const normalizedWords = normalizeWordList(words);
    if (!normalizedWords.length) {
        regexBSTest = null;
        regexBSReplace = null;
        compiledWordsSignature = '';
        return false;
    }

    const nextSignature = normalizedWords.join('\u0001');
    if (nextSignature === compiledWordsSignature && regexBSTest && regexBSReplace) {
        return false;
    }

    // 1. Kullanıcının kelimelerini aşılmaz Türkçe Regex matrisine çevirmeden önce escape ediyoruz
    const safeWords = normalizedWords.map(escapeRegExp);
    const turkishWords = safeWords.map(makeTurkishRegex);
    const combined = turkishWords.join('|');

    // 2. Kelimenin herhangi bir yerde geçmesini sağlayacak şekilde (kısıtlamasız yakalama)
    try {
        const source = `(?<![a-zıİğĞüÜşŞçÇöÖ])(${combined})(?![a-zıİğĞüÜşŞçÇöÖ])`;
        regexBSTest = new RegExp(source, 'iu');
        regexBSReplace = new RegExp(source, 'giu');
        compiledWordsSignature = nextSignature;
        return true;
    } catch (e) {
        console.error("Critical: Failed to compile BS Filter regex.", e);
        regexBSTest = null;
        regexBSReplace = null;
        compiledWordsSignature = '';
        return false;
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

function getCurrentWeekKey() {
    const now = new Date();
    const utcDate = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const dayNum = utcDate.getUTCDay() || 7;
    utcDate.setUTCDate(utcDate.getUTCDate() + 4 - dayNum);

    const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((utcDate - yearStart) / 86400000) + 1) / 7);

    return `${utcDate.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function ensureStatsWeekContext() {
    const currentWeekKey = getCurrentWeekKey();
    if (sessionWeekKey !== currentWeekKey) {
        sessionWeekKey = currentWeekKey;
        sessionReportedHashes = new Set();
    }
    return currentWeekKey;
}

function createEmptyWeeklyStats(weekKey) {
    return {
        weekKey,
        totalCatches: 0,
        totalPosts: 0,
        topWords: {},
        seenPostHashes: [],
        updatedAt: Date.now()
    };
}

function normalizeStatWord(word) {
    if (!word) return '';
    return word
        .toLocaleLowerCase('tr-TR')
        .replace(/\s+/g, ' ')
        .trim();
}

function hashString(input) {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }

    return (hash >>> 0).toString(36);
}

function createPostFingerprint(post) {
    const cachedFingerprint = postFingerprintCache.get(post);
    if (cachedFingerprint) return cachedFingerprint;

    const urn = (post.getAttribute && (post.getAttribute('data-urn') || post.getAttribute('data-id'))) || '';
    const textSample = (post.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 220);

    const fingerprint = hashString(`${urn}|${textSample}`);
    postFingerprintCache.set(post, fingerprint);
    return fingerprint;
}

function pruneWordFrequencyMap(wordMap) {
    const entries = Object.entries(wordMap || {});
    if (entries.length <= maxTrackedWords) return wordMap || {};

    entries.sort((a, b) => b[1] - a[1]);
    return Object.fromEntries(entries.slice(0, maxTrackedWords));
}

function flushPendingStats() {
    if (!pendingStatsRecords.length) return;

    ensureStatsWeekContext();

    const recordsToFlush = pendingStatsRecords;
    pendingStatsRecords = [];

    chrome.storage.local.get({ [weeklyStatsStorageKey]: null }, (result) => {
        const weekKey = ensureStatsWeekContext();
        let stats = result[weeklyStatsStorageKey];

        if (!stats || stats.weekKey !== weekKey) {
            stats = createEmptyWeeklyStats(weekKey);
        }

        const seenSet = new Set(stats.seenPostHashes || []);

        recordsToFlush.forEach((record) => {
            if (seenSet.has(record.fingerprint)) return;

            seenSet.add(record.fingerprint);
            stats.totalPosts += 1;
            stats.totalCatches += record.score;

            Object.entries(record.words).forEach(([word, count]) => {
                stats.topWords[word] = (stats.topWords[word] || 0) + count;
            });
        });

        stats.topWords = pruneWordFrequencyMap(stats.topWords);
        stats.seenPostHashes = Array.from(seenSet).slice(-maxSeenHashesPerWeek);
        stats.updatedAt = Date.now();

        chrome.storage.local.set({ [weeklyStatsStorageKey]: stats });
    });
}

function scheduleStatsFlush() {
    clearTimeout(statsFlushTimer);
    statsFlushTimer = setTimeout(() => {
        flushPendingStats();
    }, statsFlushDelayMs);
}

function queueStatsFromPostMetrics(postMetrics) {
    if (!postMetrics || postMetrics.size === 0) return;

    ensureStatsWeekContext();

    const records = [];

    postMetrics.forEach((metric, post) => {
        if (!metric || !metric.score) return;

        const fingerprint = createPostFingerprint(post);
        if (!fingerprint || sessionReportedHashes.has(fingerprint)) return;

        sessionReportedHashes.add(fingerprint);

        records.push({
            fingerprint,
            score: metric.score,
            words: metric.words,
            emojiCount: metric.emojiCount
        });
    });

    if (!records.length) return;

    pendingStatsRecords.push(...records);
    if (pendingStatsRecords.length > 800) {
        pendingStatsRecords = pendingStatsRecords.slice(-800);
    }

    scheduleStatsFlush();
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

function resolvePostContainerForWrapper(wrapper) {
    const cachedPost = wrapperPostCache.get(wrapper);
    if (cachedPost && cachedPost.isConnected) {
        return cachedPost;
    }

    let post = findPostContainer(wrapper.parentElement || wrapper);
    if (!post && wrapper.closest) {
        post = wrapper.closest('li, article, [role="article"], [data-urn], [data-id], .fie-impression-container');
    }

    if (!post) {
        post = findFallbackScorableContainer(wrapper.parentElement || wrapper);
    }

    if (!post) return null;

    if (['SPAN', 'P', 'A'].includes(post.tagName) && post.parentElement) {
        post = post.parentElement;
    }

    if (post) {
        wrapperPostCache.set(wrapper, post);
    }

    return post;
}

function getWrapperWordCounts(wrapper) {
    const cachedWordCounts = wrapperWordsCache.get(wrapper);
    if (cachedWordCounts) return cachedWordCounts;

    const serializedWords = wrapper.getAttribute('data-bs-words');
    if (serializedWords) {
        try {
            const parsed = JSON.parse(serializedWords);
            wrapperWordsCache.set(wrapper, parsed);
            return parsed;
        } catch (error) {
            // Corrupted payload fallback to live extraction.
        }
    }

    const extractedWords = {};
    wrapper.querySelectorAll('span.bs-keyword').forEach((keywordNode) => {
        const rawWord = keywordNode.getAttribute('data-orig') || '';
        const normalizedWord = normalizeStatWord(rawWord);
        if (!normalizedWord) return;

        extractedWords[normalizedWord] = (extractedWords[normalizedWord] || 0) + 1;
    });

    wrapperWordsCache.set(wrapper, extractedWords);
    return extractedWords;
}

function clearPostScoring() {
    document.querySelectorAll('.bs-post-badge').forEach((badge) => badge.remove());
    document.querySelectorAll('.bs-post-preview').forEach((preview) => preview.remove());
    document.querySelectorAll('.bs-scored-post, .bs-collapsed-post').forEach((post) => {
        post.classList.remove('bs-scored-post', 'bs-collapsed-post');
        post.removeAttribute('data-bs-score');
        delete post.dataset.bsForceOpen;
    });

    scoredPostsCache = new Set();
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

    const postMetrics = new Map();
    document.querySelectorAll('span.bs-main-wrapper').forEach((wrapper) => {
        const post = resolvePostContainerForWrapper(wrapper);
        if (!post) return;

        const bsCountRaw = Number.parseInt(wrapper.getAttribute('data-bs-count') || '', 10);
        const emojiCountRaw = Number.parseInt(wrapper.getAttribute('data-emoji-count') || '', 10);
        const bsCount = Number.isNaN(bsCountRaw) ? wrapper.querySelectorAll('span.bs-keyword').length : bsCountRaw;
        const emojiCount = Number.isNaN(emojiCountRaw) ? wrapper.querySelectorAll('span.emoji-wrapper').length : emojiCountRaw;
        const nodeScore = bsCount + emojiCount;
        if (!nodeScore) return;

        const metric = postMetrics.get(post) || {
            score: 0,
            emojiCount: 0,
            words: {}
        };

        metric.score += nodeScore;
        metric.emojiCount += emojiCount;

        const wrapperWordCounts = getWrapperWordCounts(wrapper);
        Object.entries(wrapperWordCounts).forEach(([word, count]) => {
            metric.words[word] = (metric.words[word] || 0) + count;
        });

        postMetrics.set(post, metric);
    });

    const currentScoredPosts = new Set(postMetrics.keys());
    scoredPostsCache.forEach((post) => {
        if (currentScoredPosts.has(post)) return;
        post.classList.remove('bs-scored-post', 'bs-collapsed-post');
        post.removeAttribute('data-bs-score');
        delete post.dataset.bsForceOpen;
        clearCollapsedPreview(post);

        const badge = getDirectBadge(post);
        if (badge) badge.remove();
    });

    postMetrics.forEach((metric, post) => {
        upsertPostBadge(post, metric.score);
    });

    scoredPostsCache = currentScoredPosts;

    queueStatsFromPostMetrics(postMetrics);
}

function schedulePostScoring() {
    if (!scoreSettings.enableScoring) return;

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

function startObserver() {
    if (isObserverRunning || !document.body) return;

    resetObserverCounterWindow();
    observer.observe(document.body, { childList: true, subtree: true });
    isObserverRunning = true;
}

function stopObserver() {
    if (!isObserverRunning) return;

    observer.disconnect();
    isObserverRunning = false;
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
    stopObserver();
    clearTimeout(observerCooldownTimer);
    observerCooldownTimer = setTimeout(() => {
        startObserver();
    }, 800);
}

// ÇÖZÜM: DOM'u %100 Orijinal Haline Getiren Gelişmiş Temizleyici
function restoreDOM() {
    const wrappers = document.querySelectorAll('span.bs-main-wrapper');
    wrappers.forEach(wrapper => {
        const originalText = wrapper.getAttribute('data-original-text');
        const textNode = document.createTextNode(originalText !== null ? originalText : wrapper.textContent);
        wrapper.parentNode.replaceChild(textNode, wrapper);
    });

    clearPostScoring();
}

function processTextNode(node) {
    if (!node.nodeValue || !node.parentNode) return false;
    if (!isWithinProcessingScope(node)) return false;
    if (isInsideIgnoredContainer(node)) return false;
    
    const originalText = node.nodeValue;
    
    // İşlem yapmaya gerek var mı diye kontrol et (Performans için)
    const hasEmoji = regexEmojiTest.test(originalText);
    const hasBS = regexBSTest ? regexBSTest.test(originalText) : false;
    
    if (!hasEmoji && !hasBS) return false; // İkisi de yoksa pas geç

    // Güvenli HTML string'i oluştur
    let processedHTML = escapeHTML(originalText);
    let emojiCount = 0;
    let bsCount = 0;
    const wordCounts = {};
    
    // 1. Emojileri stateful span'ler ile değiştir
    if (hasEmoji) {
        regexEmojiReplace.lastIndex = 0;
        // Orijinal emojiyi data-orig içine saklıyoruz
        processedHTML = processedHTML.replace(regexEmojiReplace, (match) => {
            emojiCount += 1;
            return `<span class="emoji-wrapper" data-orig="${match}">🤡</span>`;
        });
    }
    
    // 2. BS kelimelerini değiştir
    if (hasBS && regexBSReplace) {
        regexBSReplace.lastIndex = 0;
        processedHTML = processedHTML.replace(regexBSReplace, (match) => {
            bsCount += 1;

            const normalizedWord = normalizeStatWord(match);
            if (normalizedWord) {
                wordCounts[normalizedWord] = (wordCounts[normalizedWord] || 0) + 1;
            }

            return `<span class="bs-keyword" data-orig="${match}">🔴</span>`;
        });
    }

    // Tek bir ana kapsayıcı (wrapper) oluştur ve DOM'a bas
    const span = document.createElement('span');
    span.className = 'bs-main-wrapper';
    span.setAttribute('data-original-text', originalText);
    span.setAttribute('data-bs-count', String(bsCount));
    span.setAttribute('data-emoji-count', String(emojiCount));
    if (bsCount > 0) {
        const serializedWords = JSON.stringify(wordCounts);
        span.setAttribute('data-bs-words', serializedWords);
        wrapperWordsCache.set(span, wordCounts);
    }

    span.innerHTML = processedHTML;
    node.parentNode.replaceChild(span, node);
    return true;
}

function walkAndProcess(rootElement) {
    if (!rootElement) return 0;

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
    let changedCount = 0;

    while (nextNode) {
        currentNode = nextNode;
        nextNode = walker.nextNode(); // grab the next BEFORE processing/replacing the current node
        if (processTextNode(currentNode)) {
            changedCount += 1;
        }
    }

    return changedCount;
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

                    const changedCount = walkAndProcess(node);
                    if (changedCount > 0) {
                        hasRelevantMutations = true;
                    }
                } else if (node.nodeType === Node.TEXT_NODE) {
                    if (node.parentElement && node.parentElement.closest('.bs-post-badge')) return;
                    if (node.parentElement && node.parentElement.closest('.bs-post-preview')) return;
                    if (!isWithinProcessingScope(node) || isInsideIgnoredContainer(node)) return;

                    if (processTextNode(node)) {
                        hasRelevantMutations = true;
                    }
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

function processAllRoots() {
    isMutating = true;
    let totalChanges = 0;

    try {
        getProcessingRoots().forEach((root) => {
            totalChanges += walkAndProcess(root);
        });
    } finally {
        isMutating = false;
    }

    return totalChanges;
}

chrome.storage.sync.get({
    isActive: true,
    bsWords: typeof allDefaultBSWords !== 'undefined' ? allDefaultBSWords : [],
    enableScoring: true,
    scoreThreshold: defaultScoreThreshold
}, (state) => {
    updateScoreSettings(state);
    const initialWords = Array.isArray(state.bsWords) ? state.bsWords : [];
    currentWordsSignature = getWordsSignature(initialWords);

    if (!state.isActive) {
        isEngineActive = false;
        stopObserver();
        return;
    }

    updateRegex(initialWords);
    isEngineActive = true;
    
    // Sayfa yüklenirken latency toleransı
    setTimeout(() => {
        processAllRoots();
        if (scoreSettings.enableScoring) {
            applyPostScoring();
        }
        startObserver();
    }, 2000);
});

// Real-time İletişim: Aç/Kapat ve Kelime Ekle/Çıkar
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "updateState" && request.state) {
        updateScoreSettings(request.state);

        const shouldBeActive = request.state.isActive !== false;
        if (!shouldBeActive) {
            stopObserver();
            clearTimeout(observerCooldownTimer);
            clearTimeout(scoreRefreshTimer);
            clearTimeout(statsFlushTimer);
            flushPendingStats();

            if (isEngineActive) {
                restoreDOM(); // Emojileri ve kelimeleri geri getir
            }

            isEngineActive = false;
            currentWordsSignature = '';
            console.log("🛑 Motor durduruldu, orijinal DOM yüklendi.");
            return;
        }

        const incomingWords = Array.isArray(request.state.bsWords) ? request.state.bsWords : [];
        const nextWordsSignature = getWordsSignature(incomingWords);
        const wordsChanged = nextWordsSignature !== currentWordsSignature;
        const shouldRescanText = !isEngineActive || wordsChanged;

        if (shouldRescanText) {
            stopObserver();
            updateRegex(incomingWords);
            currentWordsSignature = nextWordsSignature;

            if (isEngineActive) {
                restoreDOM(); // Önce eski kalıntıları temizle
            }
            processAllRoots(); // Yeni kurallarla tekrar tara
        }

        if (scoreSettings.enableScoring) {
            applyPostScoring();
        } else {
            clearPostScoring();
        }

        isEngineActive = true;
        startObserver();
    }
});

window.addEventListener('beforeunload', () => {
    clearTimeout(statsFlushTimer);
    flushPendingStats();
});