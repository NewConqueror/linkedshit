// DOM Elementlerini Yakala
const toggleExtension = document.getElementById('toggleExtension');
const newWordInput = document.getElementById('newWord');
const addBtn = document.getElementById('addBtn');
const wordList = document.getElementById('wordList');
const enableScoring = document.getElementById('enableScoring');
const scoreThreshold = document.getElementById('scoreThreshold');
const scoreThresholdValue = document.getElementById('scoreThresholdValue');
const applyScoreBtn = document.getElementById('applyScoreBtn');

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
});

// 2. UI ÇİZİM FONKSİYONU
function renderList() {
    wordList.innerHTML = ''; // Listeyi temizle
    state.bsWords.forEach((word, index) => {
        const li = document.createElement('li');
        li.textContent = word;
        
        const delBtn = document.createElement('button');
        delBtn.textContent = 'X';
        delBtn.className = 'delete-btn';
        delBtn.onclick = () => removeWord(index); // Silme event'i
        
        li.appendChild(delBtn);
        wordList.appendChild(li);
    });
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