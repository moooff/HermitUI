// < !-- ===================================================== -->
// < !--HermitUI Enhancements: RTL + Auto - Save-- >
// < !--Place this block just before </body > -->
// < !-- ===================================================== -->
(function() {
    'use strict';

    // =====================================================
    // ⚙️ تنظیمات — در صورت نیاز تغییر دهید
    // =====================================================
    const OLLAMA_URL            = 'http://localhost:11434/v1';
    const AUTO_SAVE_SETTINGS    = true;
    const SETTINGS_INPUT_ID     = 'settingUrl';
    const SETTINGS_SAVE_BTN_ID  = 'settingsSave';
    const USER_INPUT_ID         = 'userInput';

    // =====================================================
    // 🔤 تشخیص RTL (فارسی + عربی + Extended)
    // =====================================================
    const RTL_REGEX          = /[\u0600-\u06FF\u0750-\u077F\u0870-\u089F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
    const RTL_REGEX_GLOBAL   = /[\u0600-\u06FF\u0750-\u077F\u0870-\u089F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
    const LATIN_REGEX        = /[A-Za-z]/;
    const LATIN_REGEX_GLOBAL = /[A-Za-z]/g;
    const SKIP_TAGS          = ['script', 'style', 'code', 'pre', 'textarea', 'input', 'button'];

    // تشخیص جهت بر اساس نسبت حروف (برای پیام‌های کامل)
    function detectDirection(text) {
        if (!text || !text.trim()) return null;
        const rtl = (text.match(RTL_REGEX_GLOBAL) || []).length;
        const ltr = (text.match(LATIN_REGEX_GLOBAL) || []).length;
        if (rtl === 0 && ltr === 0) return null;
        return rtl > ltr ? 'rtl' : 'ltr';
    }

    // تشخیص جهت بر اساس اولین حرف معنادار (برای فیلد ورودی)
    function getFirstMeaningfulDirection(text) {
        if (!text) return null;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (LATIN_REGEX.test(ch)) return 'ltr';
            if (RTL_REGEX.test(ch))   return 'rtl';
        }
        return null;
    }

    // =====================================================
    // 📝 جهت‌دهی به عناصر برگ (پاراگراف، li، عنوان، ...)
    // =====================================================
    function applyDirection(el) {
        if (el.children.length > 0) return;
        if (el.closest('pre, code')) return;
        const text = el.textContent;
        if (!text || !text.trim()) return;
        const dir = detectDirection(text);
        if (!dir) return;
        if (el.getAttribute('dir') !== dir) {
            el.setAttribute('dir', dir);
            el.style.textAlign = (dir === 'rtl') ? 'right' : 'left';
        }
    }

    // =====================================================
    // 📋 جهت‌دهی به خودِ لیست‌ها (شماره/بولت هم جابه‌جا شود)
    // =====================================================
    function applyListDirection(el) {
        if (el.closest('pre, code')) return;
        const text = el.textContent;
        if (!text || !text.trim()) return;
        const dir = detectDirection(text);
        if (!dir) return;
        if (el.getAttribute('dir') !== dir) {
            el.setAttribute('dir', dir);
        }
    }

    // =====================================================
    // 🌳 پیمایش درخت DOM
    // =====================================================
    function processSubtree(root) {
        if (!root || root.nodeType !== Node.ELEMENT_NODE) return;

        // ۱) خودِ نود ریشه
        const tag = root.tagName.toLowerCase();
        if (!SKIP_TAGS.includes(tag)) {
            applyDirection(root);
        }

        // ۲) لیست‌ها (خودِ root، فرزندان، و والدِ لیست برای استریم)
        if (root.matches && root.matches('ol, ul')) applyListDirection(root);
        root.querySelectorAll('ol, ul').forEach(applyListDirection);
        const parentList = root.parentElement && root.parentElement.closest('ol, ul');
        if (parentList) applyListDirection(parentList);

        // ۳) تمام عناصر برگ
        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_ELEMENT,
            {
                acceptNode: function(node) {
                    const t = node.tagName.toLowerCase();
                    if (SKIP_TAGS.includes(t)) return NodeFilter.FILTER_REJECT;
                    if (node.children.length === 0 && node.textContent.trim()) {
                        return NodeFilter.FILTER_ACCEPT;
                    }
                    return NodeFilter.FILTER_SKIP;
                }
            }
        );
        let node;
        while ((node = walker.nextNode())) {
            applyDirection(node);
        }
    }

    function scanAll() {
        processSubtree(document.body);
    }

    // =====================================================
    // 👁️ پایش پیام‌های جدید + استریم تدریجی
    // =====================================================
    function startMessageObserver() {
        const observer = new MutationObserver(function(mutations) {
            for (const m of mutations) {
                m.addedNodes.forEach(function(node) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        processSubtree(node);
                    }
                });
                if (m.type === 'characterData') {
                    let t = m.target;
                    if (t && t.nodeType === Node.TEXT_NODE) t = t.parentNode;
                    if (t && t.nodeType === Node.ELEMENT_NODE) {
                        processSubtree(t);
                    }
                }
            }
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    // =====================================================
    // ⌨️ جهت‌دهی به فیلد ورودی (اولین حرف معنادار)
    // =====================================================
    function setupInputDirection() {
        const input = document.getElementById(USER_INPUT_ID);
        if (!input || input.dataset.rtlSetup === 'true') return;
        input.dataset.rtlSetup = 'true';

        input.addEventListener('input', function() {
            const text = this.value;

            // خالی شد → ریست
            if (!text || !text.trim()) {
                this.removeAttribute('dir');
                this.style.textAlign = '';
                this.dataset.dirLocked = '';
                return;
            }

            // اگر قبلاً قفل شده، تغییر نده
            if (this.dataset.dirLocked === 'true') return;

            const dir = getFirstMeaningfulDirection(text);
            if (!dir) return;

            this.setAttribute('dir', dir);
            this.style.textAlign = (dir === 'rtl') ? 'right' : 'left';
            this.dataset.dirLocked = 'true';
        });

        // ریست پس از ارسال پیام (Enter بدون Shift)
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                const self = this;
                setTimeout(function() {
                    self.removeAttribute('dir');
                    self.style.textAlign = '';
                    self.dataset.dirLocked = '';
                }, 0);
            }
        });
    }

    // =====================================================
    // 💾 پر کردن URL و کلیک خودکار روی Save
    // =====================================================
    let settingsDone = false;

    function autoSaveSettings() {
        if (settingsDone || !AUTO_SAVE_SETTINGS) return true;

        const saveBtn = document.getElementById(SETTINGS_SAVE_BTN_ID);
        if (!saveBtn) return false;

        const input = document.getElementById(SETTINGS_INPUT_ID);
        if (input && input.value !== OLLAMA_URL) {
            input.value = OLLAMA_URL;
            input.dispatchEvent(new Event('input',  { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }

        saveBtn.click();
        settingsDone = true;
        return true;
    }

    // =====================================================
    // 🚀 اجرا
    // =====================================================
    function boot() {
        scanAll();
        startMessageObserver();
        setupInputDirection();

        // ذخیره تنظیمات پس از لود کامل صفحه
        window.addEventListener('load', function() {
            setTimeout(function() {
                if (autoSaveSettings()) return;

                // اگر دکمه هنوز در DOM نبود، تا ۳۰ ثانیه منتظر بمان
                let tries = 0;
                const timer = setInterval(function() {
                    tries++;
                    if (autoSaveSettings() || tries > 150) clearInterval(timer);
                }, 200);
            }, 300);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();