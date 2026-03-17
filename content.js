let isMutating = false;
let bsWords = [];
let regexBS = null;
const regexEmoji = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;

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

        // 2. Artık wrapper'ın içindeki tüm metin (textContent) %100 orijinal halinde. 
        // Wrapper'ı yok et ve yerine saf metin düğümü koy.
        const originalTextNode = document.createTextNode(wrapper.textContent);
        wrapper.parentNode.replaceChild(originalTextNode, wrapper);
    });
}

function processTextNode(node) {
    if (!node.nodeValue || !node.parentNode) return;
    
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
        processedHTML = processedHTML.replace(regexBS, '<span class="bs-keyword" style="color:red; font-weight:bold; text-decoration:underline;">$&</span>');
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
                parent.closest('[contenteditable="plaintext-only"]')
            ) {
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
    
    isMutating = true;
    try {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    walkAndProcess(node);
                } else if (node.nodeType === Node.TEXT_NODE) {
                    processTextNode(node);
                }
            });
        });
    } catch (err) {
        console.error("DOM İşlem Hatası:", err);
    } finally {
        isMutating = false;
    }
});

chrome.storage.sync.get({ isActive: true, bsWords: typeof allDefaultBSWords !== 'undefined' ? allDefaultBSWords : [] }, (state) => {
    if (!state.isActive) return;
    updateRegex(state.bsWords);
    
    // Sayfa yüklenirken latency toleransı
    setTimeout(() => {
        isMutating = true;
        walkAndProcess(document.body);
        isMutating = false;
    }, 2000);
    
    observer.observe(document.body, { childList: true, subtree: true });
});

// Real-time İletişim: Aç/Kapat ve Kelime Ekle/Çıkar
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "updateState") {
        isMutating = true;
        
        if (request.state.isActive === false) {
            observer.disconnect();
            restoreDOM(); // Emojileri ve kelimeleri geri getir
            console.log("🛑 Motor durduruldu, orijinal DOM yüklendi.");
            isMutating = false;
        } else {
            updateRegex(request.state.bsWords);
            restoreDOM(); // Önce eski kalıntıları temizle
            walkAndProcess(document.body); // Yeni kurallarla tekrar tara
            isMutating = false;
            observer.observe(document.body, { childList: true, subtree: true });
        }
    }
});