// DOM Elementlerini Yakala
const toggleExtension = document.getElementById('toggleExtension');
const newWordInput = document.getElementById('newWord');
const addBtn = document.getElementById('addBtn');
const wordList = document.getElementById('wordList');
const enableScoring = document.getElementById('enableScoring');
const scoreThreshold = document.getElementById('scoreThreshold');
const scoreThresholdValue = document.getElementById('scoreThresholdValue');
const applyScoreBtn = document.getElementById('applyScoreBtn');
const weeklyCatchCount = document.getElementById('weeklyCatchCount');
const weeklyPostCount = document.getElementById('weeklyPostCount');
const topWordsList = document.getElementById('topWordsList');
const statsEmpty = document.getElementById('statsEmpty');
const resetStatsBtn = document.getElementById('resetStatsBtn');

const weeklyStatsStorageKey = 'bsWeeklyStatsV1';
const topWordsLimit = 5;

// Varsayılan State
let state = {
    isActive: true,
    bsWords: [],
    enableScoring: true,
    scoreThreshold: 6
};

let pendingScoreThreshold = 6;

function sortWordsAlphabetically(words) {
    return [...words].sort((a, b) => a.localeCompare(b, ['tr', 'en'], { sensitivity: 'base' }));
}

function normalizeThreshold(value) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return 6;
    return Math.min(20, Math.max(1, parsed));
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

function createEmptyWeeklyStats() {
    return {
        weekKey: getCurrentWeekKey(),
        totalCatches: 0,
        totalPosts: 0,
        topWords: {},
        seenPostHashes: [],
        updatedAt: Date.now()
    };
}

function renderTopWords(topWords) {
    topWordsList.innerHTML = '';
    const entries = Object.entries(topWords || {}).sort((a, b) => b[1] - a[1]).slice(0, topWordsLimit);

    if (!entries.length) {
        statsEmpty.style.display = 'block';
        return;
    }

    statsEmpty.style.display = 'none';

    entries.forEach(([word, count]) => {
        const li = document.createElement('li');

        const wordSpan = document.createElement('span');
        wordSpan.className = 'stats-word';
        wordSpan.textContent = word;

        const countSpan = document.createElement('span');
        countSpan.className = 'stats-count';
        countSpan.textContent = String(count);

        li.appendChild(wordSpan);
        li.appendChild(countSpan);
        topWordsList.appendChild(li);
    });
}

function renderWeeklyStats(stats) {
    const effectiveStats = stats || createEmptyWeeklyStats();
    weeklyCatchCount.textContent = String(effectiveStats.totalCatches || 0);
    weeklyPostCount.textContent = String(effectiveStats.totalPosts || 0);
    renderTopWords(effectiveStats.topWords || {});
}

function loadWeeklyStats() {
    chrome.storage.local.get({ [weeklyStatsStorageKey]: null }, (data) => {
        const savedStats = data[weeklyStatsStorageKey];
        const weekKey = getCurrentWeekKey();

        if (!savedStats || savedStats.weekKey !== weekKey) {
            renderWeeklyStats(createEmptyWeeklyStats());
            return;
        }

        renderWeeklyStats(savedStats);
    });
}

function renderApplyButtonState() {
    const hasPendingThreshold = normalizeThreshold(pendingScoreThreshold) !== normalizeThreshold(state.scoreThreshold);
    applyScoreBtn.disabled = !state.enableScoring || !hasPendingThreshold;
}

function renderScoringControls() {
    enableScoring.checked = state.enableScoring !== false;
    scoreThreshold.value = String(pendingScoreThreshold);
    scoreThresholdValue.textContent = String(pendingScoreThreshold);
    scoreThreshold.disabled = !enableScoring.checked;
    renderApplyButtonState();
}

// 1. UYGULAMA BAŞLATILDIĞINDA: Storage'dan veriyi çek ve UI'ı çiz
chrome.storage.sync.get({
    isActive: true,
    bsWords: allDefaultBSWords,
    enableScoring: true,
    scoreThreshold: 6
}, (data) => {
    state = {
        ...data,
        enableScoring: data.enableScoring !== false,
        scoreThreshold: normalizeThreshold(data.scoreThreshold),
        bsWords: sortWordsAlphabetically(data.bsWords || [])
    };

    pendingScoreThreshold = state.scoreThreshold;

    toggleExtension.checked = state.isActive;
    renderScoringControls();
    renderList();
    loadWeeklyStats();
});

// 2. UI ÇİZİM FONKSİYONU
function renderList() {
    wordList.innerHTML = ''; // Listeyi temizle
    const fragment = document.createDocumentFragment();

    state.bsWords.forEach((word, index) => {
        const li = document.createElement('li');
        li.textContent = word;
        
        const delBtn = document.createElement('button');
        delBtn.textContent = 'X';
        delBtn.className = 'delete-btn';
        delBtn.onclick = () => removeWord(index); // Silme event'i
        
        li.appendChild(delBtn);
        fragment.appendChild(li);
    });

    wordList.appendChild(fragment);
}

// 3. THE MISSING PIECE (Eksik Parça): Veriyi Kaydet ve Sekmeye Sinyal Gönder
function saveAndNotify() {
    // Önce veritabanına (storage) yaz
    chrome.storage.sync.set(state, () => {
        // LinkedIn sekmelerinin tamamını güncelle
        chrome.tabs.query({ url: ["*://*.linkedin.com/*"] }, (tabs) => {
            tabs.forEach((tab) => {
                if (!tab.id) return;
                chrome.tabs.sendMessage(tab.id, { action: "updateState", state: state }, () => {
                    // Content script olmayan sekmelerde runtime.lastError beklenen bir durum olabilir.
                    void chrome.runtime.lastError;
                });
            });
        });
    });
}

// 4. EVENT LİSTENER'LAR (Kullanıcı Etkileşimleri)

// Toggle (Aç/Kapat) değiştiğinde
toggleExtension.addEventListener('change', (e) => {
    state.isActive = e.target.checked;
    saveAndNotify(); // Kaydet ve LinkedIn'e bildir
});

enableScoring.addEventListener('change', (e) => {
    state.enableScoring = e.target.checked;
    renderScoringControls();
    saveAndNotify();
});

scoreThreshold.addEventListener('input', (e) => {
    const normalized = normalizeThreshold(e.target.value);
    pendingScoreThreshold = normalized;
    scoreThresholdValue.textContent = String(normalized);
    renderApplyButtonState();
});

applyScoreBtn.addEventListener('click', () => {
    state.scoreThreshold = normalizeThreshold(pendingScoreThreshold);
    renderScoringControls();
    saveAndNotify();
});

resetStatsBtn.addEventListener('click', () => {
    const freshStats = createEmptyWeeklyStats();
    chrome.storage.local.set({ [weeklyStatsStorageKey]: freshStats }, () => {
        renderWeeklyStats(freshStats);
    });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const statsChange = changes[weeklyStatsStorageKey];
    if (!statsChange) return;

    const weekKey = getCurrentWeekKey();
    const nextStats = statsChange.newValue;
    if (!nextStats || nextStats.weekKey !== weekKey) {
        renderWeeklyStats(createEmptyWeeklyStats());
        return;
    }

    renderWeeklyStats(nextStats);
});

// Yeni kelime eklendiğinde
addBtn.addEventListener('click', () => {
    const word = newWordInput.value.trim();
    if (word && !state.bsWords.includes(word)) {
        state.bsWords.push(word);
        state.bsWords = sortWordsAlphabetically(state.bsWords);
        newWordInput.value = ''; // Input'u temizle
        renderList(); // Arayüzü güncelle
        saveAndNotify(); // Kaydet ve LinkedIn'e bildir
    }
});

// Enter tuşuyla kelime ekleme desteği
newWordInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addBtn.click();
});

// Kelime silindiğinde
function removeWord(index) {
    state.bsWords.splice(index, 1);
    renderList(); // Arayüzü güncelle
    saveAndNotify(); // Kaydet ve LinkedIn'e bildir
}