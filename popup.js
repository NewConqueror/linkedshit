// DOM Elementlerini Yakala
const toggleExtension = document.getElementById('toggleExtension');
const newWordInput = document.getElementById('newWord');
const addBtn = document.getElementById('addBtn');
const wordList = document.getElementById('wordList');

// Varsayılan State
let state = { isActive: true, bsWords: [] };

function sortWordsAlphabetically(words) {
    return [...words].sort((a, b) => a.localeCompare(b, ['tr', 'en'], { sensitivity: 'base' }));
}

// 1. UYGULAMA BAŞLATILDIĞINDA: Storage'dan veriyi çek ve UI'ı çiz
chrome.storage.sync.get({ isActive: true, bsWords: allDefaultBSWords }, (data) => {
    state = {
        ...data,
        bsWords: sortWordsAlphabetically(data.bsWords || [])
    };
    toggleExtension.checked = state.isActive;
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
        // Sonra aktif olan Chrome sekmesini (tab) bul
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            // Eğer aktif sekme bir LinkedIn sayfasıysa, content.js'e mesajı ateşle
            if (tabs[0] && tabs[0].url.includes("linkedin.com")) {
                chrome.tabs.sendMessage(tabs[0].id, { action: "updateState", state: state });
            }
        });
    });
}

// 4. EVENT LİSTENER'LAR (Kullanıcı Etkileşimleri)

// Toggle (Aç/Kapat) değiştiğinde
toggleExtension.addEventListener('change', (e) => {
    state.isActive = e.target.checked;
    saveAndNotify(); // Kaydet ve LinkedIn'e bildir
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