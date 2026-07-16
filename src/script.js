// ========== Configuration ==========
        const CONSTANTS = {
            THROTTLE_MS: 80,
            MAX_TEXTAREA_HEIGHT_PX: 200,
            MAX_IMAGE_DIM_PX: 1568
        };

        // Escape text destined for HTML / attribute contexts.
        function escapeHtml(str) {
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        marked.use({
            renderer: {
                code(codeArg, infoArg) {
                    // marked v12 passes positional args (code, infostring); v13+ passes a token object.
                    const text = (codeArg && typeof codeArg === 'object') ? codeArg.text : codeArg;
                    const lang = (codeArg && typeof codeArg === 'object') ? codeArg.lang : infoArg;
                    const language = (lang || '').match(/\S*/)[0];
                    const validLanguage = hljs.getLanguage(language) ? language : 'plaintext';
                    const highlighted = hljs.highlight(text || '', { language: validLanguage, ignoreIllegals: true }).value;
                    // Keep the real "mermaid" tag (hljs doesn't know it and would say
                    // "plaintext") so the diagram post-pass can find these fences.
                    const cssLang = language === 'mermaid' ? 'mermaid' : validLanguage;
                    return `<pre><code class="hljs language-${cssLang}">${highlighted}</code></pre>`;
                }
            }
        });

        // ========== Math Rendering (KaTeX → native MathML) ==========
        // KaTeX is used in MathML-only mode: browsers render <math> natively, so none
        // of KaTeX's webfonts or CSS are needed — only katex.min.js ships in the build.
        function renderMathTex(tex, displayMode) {
            if (typeof katex === 'undefined') return null;
            try {
                return katex.renderToString(tex, { displayMode, output: 'mathml', throwOnError: false });
            } catch (e) {
                return null;
            }
        }

        // marked extensions so math participates in normal Markdown tokenization.
        // Fenced/inline code is tokenized positionally before these ever run, so
        // "$..$" inside code blocks is never treated as math.
        marked.use({
            extensions: [
                {
                    name: 'mathBlock',
                    level: 'block',
                    start(src) {
                        const m = src.match(/\$\$|\\\[/);
                        return m ? m.index : undefined;
                    },
                    tokenizer(src) {
                        const match = src.match(/^\$\$([\s\S]+?)\$\$/) || src.match(/^\\\[([\s\S]+?)\\\]/);
                        if (match) return { type: 'mathBlock', raw: match[0], text: match[1].trim() };
                    },
                    renderer(token) {
                        const html = renderMathTex(token.text, true);
                        return html !== null ? `<p class="math-block">${html}</p>` : `<p>${escapeHtml(token.raw)}</p>`;
                    }
                },
                {
                    name: 'mathInline',
                    level: 'inline',
                    start(src) {
                        const m = src.match(/\$|\\\(/);
                        return m ? m.index : undefined;
                    },
                    tokenizer(src) {
                        let match = src.match(/^\\\(([\s\S]+?)\\\)/) || src.match(/^\$\$([^$\n]+?)\$\$/);
                        // Currency guard for single-$ math: no space right after the
                        // opening $ or before the closing $, and the closing $ must not
                        // be followed by a digit — so "$5 and $10" stays plain text.
                        if (!match) match = src.match(/^\$(?!\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d)/);
                        if (match) {
                            return { type: 'mathInline', raw: match[0], text: match[1], display: match[0].startsWith('$$') };
                        }
                    },
                    renderer(token) {
                        const html = renderMathTex(token.text, token.display);
                        return html !== null ? html : escapeHtml(token.raw);
                    }
                }
            ]
        });

        // ========== Mermaid Diagrams ==========
        // Shared with the wllama engine loader: build.py embeds heavyweight assets
        // gzipped + base64-encoded, and they are inflated in-browser on first use via
        // the native DecompressionStream API.
        async function gunzipToBytes(b64) {
            const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
            return new Uint8Array(await new Response(stream).arrayBuffer());
        }

        // The dev source / CDN / local builds load mermaid via a <script> tag; the
        // single-file builds carry it as window.__MERMAID_INLINE__ (gzip + base64,
        // injected by build.py) and only pay the inflate cost when a diagram appears.
        let mermaidLoadPromise = null;
        let mermaidSeq = 0;
        function loadMermaid() {
            if (mermaidLoadPromise) return mermaidLoadPromise;
            mermaidLoadPromise = (async () => {
                if (typeof window.mermaid === 'undefined') {
                    if (!window.__MERMAID_INLINE__) throw new Error('Mermaid engine not available');
                    const bytes = await gunzipToBytes(window.__MERMAID_INLINE__);
                    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
                    await new Promise((resolve, reject) => {
                        const s = document.createElement('script');
                        s.src = blobUrl;
                        s.onload = resolve;
                        s.onerror = () => reject(new Error('Failed to load embedded mermaid engine'));
                        document.head.appendChild(s);
                    });
                }
                return window.mermaid;
            })();
            mermaidLoadPromise.catch(() => { mermaidLoadPromise = null; }); // allow retry
            return mermaidLoadPromise;
        }

        // Replace finished ```mermaid fences with rendered diagrams. Runs only on
        // final message renders (streaming keeps showing the code block). Any invalid
        // diagram source simply stays a code block.
        async function renderMermaidBlocks(container) {
            const blocks = container.querySelectorAll('pre > code.language-mermaid');
            if (blocks.length === 0) return;
            let mermaid;
            try {
                mermaid = await loadMermaid();
            } catch (e) {
                return;
            }
            // Re-initialized per pass so new diagrams follow the current theme.
            // htmlLabels stays off: labels render as plain SVG text, so no
            // <foreignObject> for DOMPurify to strip below.
            mermaid.initialize({
                startOnLoad: false,
                securityLevel: 'strict',
                theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default',
                htmlLabels: false,
                flowchart: { htmlLabels: false }
            });
            for (const code of blocks) {
                const pre = code.closest('pre');
                if (!pre || !pre.parentNode) continue;
                const renderId = `hermit-mermaid-${++mermaidSeq}`;
                try {
                    const { svg } = await mermaid.render(renderId, code.textContent);
                    const wrapper = document.createElement('div');
                    wrapper.className = 'mermaid-diagram';
                    // Mermaid (strict mode) sanitizes labels itself; this outer pass
                    // enforces the project rule that all AI-derived HTML goes through
                    // DOMPurify. <style> must be re-allowed — mermaid themes its SVG
                    // with an embedded, self-generated stylesheet.
                    wrapper.innerHTML = DOMPurify.sanitize(svg, {
                        USE_PROFILES: { svg: true, svgFilters: true },
                        ADD_TAGS: ['style']
                    });
                    if (!wrapper.querySelector('svg')) continue;
                    pre.replaceWith(wrapper);
                } catch (e) {
                    // Mermaid can leave an error placeholder element behind on failure.
                    const stray = document.getElementById('d' + renderId);
                    if (stray) stray.remove();
                }
            }
        }

        // ========== Persona Presets ==========
        const BASE_PROMPT = `You are a helpful AI assistant running inside HermitUI, a local-first, privacy-focused chat interface. All data stays on the user's machine — never add privacy disclaimers or data-sharing warnings.
You do not have internet access, tools, or the ability to execute code. Answer based solely on your training data. Never start responses with "As an AI..." and never apologize unnecessarily. Speak directly and confidently.

Your output is rendered as GitHub Flavored Markdown (tables, fenced code blocks with language tags, bold, lists). Respond in the same language the user writes in.

Today is ${new Date().toLocaleDateString('en-US', {weekday:'long'})}, ${new Date().toISOString().slice(0,10)}.`;

        const PERSONAS = {
            technical: {
                label: "Technical Assistant",
                icon: "🔧",
                prompt: BASE_PROMPT + `\n\nYou are an expert technical assistant.

Rules:
- Be direct. No filler, no marketing speak.
- Use fenced code blocks with language identifiers (e.g., \`\`\`python).
- Only comment on non-obvious parts of code. Omit boilerplate explanations.
- When providing code, give complete, runnable snippets the user can copy-paste directly, unless only a small fix is needed.
- When the user pastes an error or stack trace, diagnose the root cause first, then provide the fix.
- For complex problems, state your reasoning in 2-3 concise steps before the solution.
- If a request is ambiguous or missing critical context, ask the minimum number of clarifying questions needed (ideally 1-2).
- Prefer concise answers. For simple questions, keep it brief. For complex problems, use as much space as needed but avoid repetition.`
            },
            general: {
                label: "General Assistant",
                icon: "💬",
                prompt: BASE_PROMPT + `\n\nYou are a friendly, versatile general-purpose assistant.

Rules:
- Be helpful, clear, and conversational.
- Adapt your tone and depth to match the user's question — casual for simple queries, detailed for complex ones.
- Avoid lengthy introductory and concluding remarks. Get straight to the point.
- Use formatting (bold, lists, headings) to improve readability when it helps, but don't over-format short answers.
- Use bullet points whenever listing three or more items to maximize scannability.
- If a question spans multiple domains, address each part clearly.
- Ask for clarification when the request is genuinely ambiguous, but make reasonable assumptions for minor gaps.`
            },
            writing: {
                label: "Writing Assistant",
                icon: "✍️",
                prompt: BASE_PROMPT + `\n\nYou are an expert writing assistant.

Rules:
- Maximize clarity, impact, and style.
- Do not use overused AI vocabulary (e.g., 'delve', 'testament', 'in today\\'s fast-paced world', 'landscape', 'game-changer', 'dive into', 'it\\'s important to note', 'in conclusion', 'leverage', 'harness', 'unleash', 'navigate', 'realm', 'foster', 'pave the way', 'crucial').
- Output the revised version immediately without introductory filler like 'Here is the revised text:'.
- After the text, provide a brief "Changes made:" summary only if changes are non-trivial (skip for simple typo or grammar fixes).
- If the desired tone is unclear, ask before writing.
- Offer concrete, constructive suggestions.
- Strictly preserve any markdown formatting, links, or code blocks present in the original text when rewriting.
- Maintain the author's natural voice and style. Don't overpolish casual writing into formal prose unless asked.
- Adapt your approach to the content type: for creative writing, prioritize voice and rhythm; for business writing, prioritize clarity and action; for academic writing, prioritize precision and citation-readiness.`
            },
            tutor: {
                label: "Tutor",
                icon: "🎓",
                prompt: BASE_PROMPT + `\n\nYou are a patient, encouraging tutor.

Rules:
- Use the Socratic method by default: guide with questions and hints, not direct answers.
- Adapt your vocabulary and analogies to the user's demonstrated level of understanding.
- Progressively increase complexity as the user demonstrates understanding. Start with fundamentals and build up.
- Break down complex topics into bite-sized concepts. Ask the user to confirm their understanding of one concept before moving to the next.
- Acknowledge when the user gets something right. Celebrate breakthroughs and progress to maintain motivation.
- Do not do the user's assignments or write complete solutions for them initially. Focus entirely on teaching the underlying concepts. However, if the user explicitly requests a full solution, provide it.
- If the user explicitly asks for a direct answer or a full solution, give it — then follow up with a comprehension check.
- If the user is clearly stuck after 2-3 hints, provide a more direct explanation with a worked example, then return to guided questioning.
- Keep responses focused. Prefer short explanations over lectures. Use examples, diagrams (ASCII/Markdown tables), and analogies to make concepts concrete.
- Frequently (but not always) end with a question or small exercise to check understanding.`
            }
        };
        let activePersona = "technical";

        let API_URL = "http://localhost:1234/v1";
        let API_KEY = "dummy";
        let MODEL_NAME = "local-model";
        let TEMPERATURE = 0.7;
        let MAX_TOKENS = null, TOP_P = 1, PRESENCE_PENALTY = 0, FREQUENCY_PENALTY = 0, SEED = null;
        let SYSTEM_PROMPT = PERSONAS.technical.prompt;

        // ========== DOM References ==========
        const chatbox = document.getElementById("chatbox");
        
        function showEmptyState() {
            chatbox.innerHTML = `
                <div class="empty-state" id="emptyState">
                    <h1>Welcome to <span>HermitUI</span></h1>
                    <p>A fast, local, and private chat interface for your AI models. Start typing below to begin.</p>
                </div>
            `;
        }
        showEmptyState();
        const chatForm = document.getElementById("chatForm");
        const inputField = document.getElementById("userInput");
        const sendBtn = document.getElementById("sendBtn");
        const stopBtn = document.getElementById("stopBtn");
        const jumpBottomBtn = document.getElementById("jumpBottomBtn");

        let userScrolledUp = false;
        let isSmoothScrolling = false;
        let smoothScrollTimeout = null;

        chatbox.addEventListener('scroll', () => {
            if (isSmoothScrolling) return;
            const distanceFromBottom = chatbox.scrollHeight - chatbox.scrollTop - chatbox.clientHeight;
            userScrolledUp = distanceFromBottom > 50;
            if (userScrolledUp) {
                jumpBottomBtn.classList.add('active');
            } else {
                jumpBottomBtn.classList.remove('active');
            }
        });

        jumpBottomBtn.addEventListener('click', () => {
            userScrolledUp = false;
            isSmoothScrolling = true;
            chatbox.scrollTo({ top: chatbox.scrollHeight, behavior: 'smooth' });
            jumpBottomBtn.classList.remove('active');
            if (smoothScrollTimeout) clearTimeout(smoothScrollTimeout);
            smoothScrollTimeout = setTimeout(() => {
                isSmoothScrolling = false;
                const distanceFromBottom = chatbox.scrollHeight - chatbox.scrollTop - chatbox.clientHeight;
                if (distanceFromBottom <= 50) {
                    userScrolledUp = false;
                    jumpBottomBtn.classList.remove('active');
                }
            }, 800);
        });

        // ========== Overlay Update ==========
        function updateOverlay() {
            document.getElementById("overlayModel").textContent = MODEL_NAME;
            try {
                document.getElementById("overlayUrl").textContent = new URL(API_URL).origin;
            } catch(e) {
                document.getElementById("overlayUrl").textContent = API_URL;
            }
        }
        updateOverlay();

        function updateMainCloudWarning() {
            const url = API_URL.toLowerCase();
            const cloudProviders = ["openai.com", "openrouter.ai", "groq.com", "anthropic.com", "together.xyz", "x.ai", "deepseek.com", "api.gemini.com", "cloudflare.com"];
            const match = cloudProviders.find(p => url.includes(p));
            const banner = document.getElementById("mainScreenCloudWarning");
            if (banner) {
                if (match) {
                    document.getElementById("mainCloudProviderName").textContent = match;
                    banner.style.display = "flex";
                } else {
                    banner.style.display = "none";
                }
            }
        }
        updateMainCloudWarning();

        // ========== Persona Switcher ==========
        const personaSelect = document.getElementById("personaSelect");
        function switchPersona(key) {
            if (!PERSONAS[key]) return;
            activePersona = key;
            SYSTEM_PROMPT = PERSONAS[key].prompt;
            messages[0].content = SYSTEM_PROMPT;
            document.getElementById("settingSystem").value = SYSTEM_PROMPT;
            personaSelect.value = key;
            // Remove custom option if it exists and we're switching to a preset
            const customOpt = personaSelect.querySelector('option[value="custom"]');
            if (customOpt) customOpt.remove();
            showToast(`${PERSONAS[key].icon} Switched to ${PERSONAS[key].label}`);
        }
        personaSelect.addEventListener("change", (e) => {
            switchPersona(e.target.value);
        });

        // ========== Context Pane, File Upload & Auto-Grow ==========
        const attachContextBtn = document.getElementById("attach-context-btn");
        const contextPane = document.getElementById("context-pane");
        const contextInput = document.getElementById("context-input");
        
        let attachedFiles = [];
        const fileUpload = document.getElementById("file-upload");
        const addFileBtn = document.getElementById("add-file-btn");
        const fileChips = document.getElementById("file-chips");

        function renderChips() {
            if (!fileChips) return;
            fileChips.innerHTML = "";
            attachedFiles.forEach((f, idx) => {
                const chip = document.createElement("div");
                chip.style.cssText = "display: flex; align-items: center; background: rgba(59,130,246,0.1); color: var(--primary); padding: 4px 8px; border-radius: 12px; font-size: 0.8rem; font-weight: 500; border: 1px solid rgba(59,130,246,0.2);";

                if (f.kind === "image") {
                    const thumb = document.createElement("img");
                    thumb.className = "file-chip-thumb";
                    thumb.src = f.dataUrl; // trusted: locally-read data URL
                    thumb.alt = f.name;
                    chip.appendChild(thumb);
                }

                const nameSpan = document.createElement("span");
                nameSpan.style.cssText = "max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
                nameSpan.textContent = f.kind === "image" ? f.name : `📄 ${f.name}`; // textContent: filename is untrusted, never inject as HTML

                const removeBtn = document.createElement("button");
                removeBtn.type = "button";
                removeBtn.title = "Remove file";
                removeBtn.style.cssText = "background: none; border: none; color: inherit; margin-left: 6px; cursor: pointer; font-size: 1rem; line-height: 1;";
                removeBtn.textContent = "×";
                removeBtn.addEventListener("click", () => removeAttachedFile(idx));

                chip.appendChild(nameSpan);
                chip.appendChild(removeBtn);
                fileChips.appendChild(chip);
            });
        }

        window.removeAttachedFile = function(idx) {
            attachedFiles.splice(idx, 1);
            renderChips();
        };

        function isTextFile(file) {
            if (file.type.startsWith("text/")) return true;
            const textExtensions = ['.json', '.js', '.py', '.md', '.html', '.css', '.txt', '.csv', '.xml', '.yml', '.yaml', '.sh'];
            return textExtensions.some(ext => file.name.toLowerCase().endsWith(ext));
        }

        // Raster formats accepted by the OpenAI vision content-array. SVG is excluded:
        // vision endpoints reject image/svg+xml and it can't be rasterized safely here.
        const SUPPORTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
        function isImageFile(file) {
            return SUPPORTED_IMAGE_TYPES.includes(file.type);
        }

        // Downscale large images via canvas to keep request payloads (and vision token
        // cost) reasonable, then re-encode to a data URL. Returns a Promise<dataUrl>.
        function loadImageDownscaled(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onerror = () => reject(new Error("read failed"));
                reader.onload = (e) => {
                    const img = new Image();
                    img.onerror = () => reject(new Error("decode failed"));
                    img.onload = () => {
                        const MAX = CONSTANTS.MAX_IMAGE_DIM_PX || 1568;
                        let { width, height } = img;
                        if (width <= MAX && height <= MAX) {
                            resolve(e.target.result); // already small enough — keep original bytes
                            return;
                        }
                        const scale = MAX / Math.max(width, height);
                        width = Math.round(width * scale);
                        height = Math.round(height * scale);
                        const canvas = document.createElement("canvas");
                        canvas.width = width;
                        canvas.height = height;
                        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
                        // JPEG for photos keeps payloads small; PNG source with alpha stays PNG.
                        const outType = file.type === "image/png" ? "image/png" : "image/jpeg";
                        resolve(canvas.toDataURL(outType, 0.85));
                    };
                    img.src = e.target.result;
                };
                reader.readAsDataURL(file);
            });
        }

        function processFiles(files) {
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                if (isImageFile(file)) {
                    if (file.size > 10 * 1024 * 1024) {
                        showToast(`Image ${file.name} is too large (>10MB).`);
                        continue;
                    }
                    loadImageDownscaled(file).then(dataUrl => {
                        attachedFiles.push({ name: file.name, kind: "image", dataUrl });
                        renderChips();
                    }).catch(() => showToast(`Could not read image ${file.name}.`));
                    continue;
                }
                if (file.type.startsWith("image/")) {
                    showToast(`Image format not supported: ${file.name}. Use PNG, JPEG, GIF, or WebP.`);
                    continue;
                }
                if (file.size > 1024 * 1024) {
                    showToast(`File ${file.name} is too large (>1MB).`);
                    continue;
                }
                if (!isTextFile(file)) {
                    showToast(`File ${file.name} does not appear to be a text or image file.`);
                    continue;
                }
                const reader = new FileReader();
                reader.onload = (e) => {
                    attachedFiles.push({ name: file.name, kind: "text", content: e.target.result });
                    renderChips();
                };
                reader.readAsText(file);
            }
        }

        if (addFileBtn && fileUpload) {
            addFileBtn.addEventListener("click", () => fileUpload.click());
            fileUpload.addEventListener("change", (e) => {
                if (e.target.files.length) {
                    processFiles(e.target.files);
                    fileUpload.value = "";
                }
            });
        }

        if (contextPane) {
            contextPane.addEventListener("dragover", (e) => {
                e.preventDefault();
                contextPane.style.borderColor = "var(--primary)";
                contextPane.style.background = "rgba(59,130,246,0.05)";
            });
            contextPane.addEventListener("dragleave", (e) => {
                e.preventDefault();
                contextPane.style.borderColor = "rgba(0,0,0,0.1)";
                contextPane.style.background = "rgba(255,255,255,0.9)";
            });
            contextPane.addEventListener("drop", (e) => {
                e.preventDefault();
                contextPane.style.borderColor = "rgba(0,0,0,0.1)";
                contextPane.style.background = "rgba(255,255,255,0.9)";
                if (e.dataTransfer.files.length) {
                    processFiles(e.dataTransfer.files);
                }
            });
        }

        if (attachContextBtn && contextPane && contextInput) {
            attachContextBtn.addEventListener("click", () => {
                if (contextPane.style.display === "none") {
                    contextPane.style.display = "flex";
                    contextInput.focus();
                    attachContextBtn.style.color = "var(--primary)";
                } else {
                    contextPane.style.display = "none";
                    attachContextBtn.style.color = "#6b7280";
                }
            });
        }

        inputField.addEventListener("input", () => {
            inputField.style.height = "auto";
            inputField.style.height = Math.min(inputField.scrollHeight, CONSTANTS.MAX_TEXTAREA_HEIGHT_PX) + "px";
        });
        inputField.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                chatForm.dispatchEvent(new Event("submit", { cancelable: true }));
            }
        });

        // Clipboard image paste: pasted screenshots/images go through the same
        // processFiles pipeline as upload/drag-drop. Text paste is left untouched.
        inputField.addEventListener("paste", (e) => {
            const items = (e.clipboardData && e.clipboardData.items) || [];
            const imageFiles = [];
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (item.kind === "file" && item.type.startsWith("image/")) {
                    const file = item.getAsFile();
                    if (file) imageFiles.push(file);
                }
            }
            if (!imageFiles.length) return; // no image → normal text paste
            e.preventDefault();
            processFiles(imageFiles);
            // Reveal the context pane so the new chip is visible (mirrors attach-context-btn).
            if (contextPane && contextPane.style.display === "none") {
                contextPane.style.display = "flex";
                if (attachContextBtn) attachContextBtn.style.color = "var(--primary)";
            }
        });
        
        // Global Keyboard Shortcuts
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && settingsModal.classList.contains("active")) {
                settingsModal.classList.remove("active");
                return;
            }
            if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'n') {
                e.preventDefault();
                document.getElementById("clearBtn").click();
            } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 's') {
                e.preventDefault();
                document.getElementById("summarizeBtn").click();
            } else if (e.ctrlKey && e.key.toLowerCase() === 'e') {
                e.preventDefault();
                document.getElementById("exportBtn").click();
            }
        });

        // Prevent global drag and drop from navigating away
        document.addEventListener("dragover", (e) => { e.preventDefault(); });
        document.addEventListener("drop", (e) => { e.preventDefault(); });

        // ========== Abort Controller ==========
        let abortController = null;
        stopBtn.addEventListener("click", () => {
            if (abortController) abortController.abort();
        });

        // ========== Stats Dashboard ==========
        const inlineStats = document.getElementById("inlineStats");

        function updateGlobalStats(prompt, completion, tps, time, isEst = false) {
            document.getElementById("stat-prompt").textContent = prompt;
            document.getElementById("stat-completion").textContent = completion;
            document.getElementById("stat-tps").textContent = tps + " t/s";
            document.getElementById("stat-time").textContent = time + "s";
            document.getElementById("stat-prompt-est").style.display = isEst ? "inline" : "none";
            document.getElementById("stat-completion-est").style.display = isEst ? "inline" : "none";
        }

        // ========== About Modal ==========
        const aboutModal = document.getElementById("aboutModal");
        document.getElementById("aboutBtn").addEventListener("click", () => {
            aboutModal.classList.add("active");
        });
        document.getElementById("aboutCloseBtn").addEventListener("click", () => {
            aboutModal.classList.remove("active");
        });
        aboutModal.addEventListener("click", (e) => {
            if (e.target === aboutModal) aboutModal.classList.remove("active");
        });

        // ========== Settings Modal ==========
        const settingsModal = document.getElementById("settingsModal");
        
        function checkCloudWarning() {
            const url = document.getElementById("settingUrl").value.toLowerCase();
            const cloudProviders = ["openai.com", "openrouter.ai", "groq.com", "anthropic.com", "together.xyz", "x.ai", "deepseek.com", "api.gemini.com", "cloudflare.com"];
            const isCloud = cloudProviders.some(p => url.includes(p));
            document.getElementById("cloudWarning").style.display = isCloud ? "flex" : "none";
        }
        document.getElementById("settingUrl").addEventListener("input", checkCloudWarning);

        document.getElementById("settingsBtn").addEventListener("click", () => {
            document.getElementById("settingUrl").value = API_URL;
            checkCloudWarning();
            document.getElementById("settingApiKey").value = API_KEY;
            
            document.getElementById("settingModelInput").value = MODEL_NAME;
            const modelSelect = document.getElementById("settingModelSelect");
            if (modelSelect.options.length > 0) {
                let match = Array.from(modelSelect.options).find(o => o.value === MODEL_NAME);
                if (match) {
                    modelSelect.value = MODEL_NAME;
                    modelSelect.style.display = "block";
                    document.getElementById("settingModelInput").style.display = "none";
                } else {
                    modelSelect.style.display = "none";
                    document.getElementById("settingModelInput").style.display = "block";
                }
            } else {
                modelSelect.style.display = "none";
                document.getElementById("settingModelInput").style.display = "block";
            }
            
            document.getElementById("settingTemperature").value = TEMPERATURE;
            document.getElementById("settingMaxTokens").value = MAX_TOKENS == null ? "" : MAX_TOKENS;
            document.getElementById("settingTopP").value = TOP_P;
            document.getElementById("settingPresencePenalty").value = PRESENCE_PENALTY;
            document.getElementById("settingFrequencyPenalty").value = FREQUENCY_PENALTY;
            document.getElementById("settingSeed").value = SEED == null ? "" : SEED;
            document.getElementById("settingSystem").value = SYSTEM_PROMPT;
            updateVisionBadge();
            // @wllama:start
            document.getElementById("settingBackendMode").value = backendMode;
            document.getElementById("settingBackendMode").dispatchEvent(new Event("change"));
            // @wllama:end
            settingsModal.classList.add("active");
        });
        document.getElementById("settingsCancel").addEventListener("click", () => {
            settingsModal.classList.remove("active");
        });
        settingsModal.addEventListener("click", (e) => {
            if (e.target === settingsModal) settingsModal.classList.remove("active");
        });
        document.getElementById("settingsSave").addEventListener("click", () => {
            // @wllama:start
            backendMode = document.getElementById("settingBackendMode").value;
            // @wllama:end
            API_URL = document.getElementById("settingUrl").value.trim();
            API_KEY = document.getElementById("settingApiKey").value.trim() || "dummy";
            
            const modelSelect = document.getElementById("settingModelSelect");
            const modelInput = document.getElementById("settingModelInput");
            if (modelSelect.style.display !== "none" && modelSelect.value !== "custom") {
                MODEL_NAME = modelSelect.value;
            } else {
                MODEL_NAME = modelInput.value.trim();
            }
            
            let tempVal = parseFloat(document.getElementById("settingTemperature").value);
            TEMPERATURE = isNaN(tempVal) ? 0.7 : tempVal;

            // Advanced sampling params. Blank max_tokens/seed stay unset (null → omitted from
            // payload); top_p/penalties fall back to their neutral defaults. Values are clamped.
            const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
            const maxTokVal = parseInt(document.getElementById("settingMaxTokens").value, 10);
            MAX_TOKENS = isNaN(maxTokVal) || maxTokVal <= 0 ? null : maxTokVal;
            const topPVal = parseFloat(document.getElementById("settingTopP").value);
            TOP_P = isNaN(topPVal) ? 1 : clamp(topPVal, 0, 1);
            const presVal = parseFloat(document.getElementById("settingPresencePenalty").value);
            PRESENCE_PENALTY = isNaN(presVal) ? 0 : clamp(presVal, -2, 2);
            const freqVal = parseFloat(document.getElementById("settingFrequencyPenalty").value);
            FREQUENCY_PENALTY = isNaN(freqVal) ? 0 : clamp(freqVal, -2, 2);
            const seedVal = parseInt(document.getElementById("settingSeed").value, 10);
            SEED = isNaN(seedVal) ? null : seedVal;

            const newPrompt = document.getElementById("settingSystem").value.trim();
            SYSTEM_PROMPT = newPrompt;
            messages[0].content = SYSTEM_PROMPT;

            // Check if the edited prompt still matches a preset
            const matchingKey = Object.keys(PERSONAS).find(k => PERSONAS[k].prompt === newPrompt);
            if (matchingKey) {
                activePersona = matchingKey;
                personaSelect.value = matchingKey;
                const customOpt = personaSelect.querySelector('option[value="custom"]');
                if (customOpt) customOpt.remove();
            } else {
                // Temporary custom override
                activePersona = "custom";
                let customOpt = personaSelect.querySelector('option[value="custom"]');
                if (!customOpt) {
                    customOpt = document.createElement("option");
                    customOpt.value = "custom";
                    customOpt.textContent = "⚡ Custom";
                    personaSelect.appendChild(customOpt);
                }
                personaSelect.value = "custom";
            }

            updateOverlay();
            updateMainCloudWarning();
            settingsModal.classList.remove("active");
        });

        // @wllama:start
        document.getElementById("settingBackendMode").addEventListener("change", (e) => {
            if (e.target.value === "wllama") {
                document.getElementById("apiSettingsGroup").style.display = "none";
                document.getElementById("wllamaSettingsGroup").style.display = "block";
            } else {
                document.getElementById("apiSettingsGroup").style.display = "block";
                document.getElementById("wllamaSettingsGroup").style.display = "none";
            }
        });

        // ===== Quake-style debug console controls =====
        function setDebugConsole(open) {
            const con = document.getElementById("debugConsole");
            con.classList.toggle("open", open);
            document.getElementById("debugConsoleTab").textContent = (open ? "▴" : "▾") + " debug";
        }
        function toggleDebugConsole() {
            setDebugConsole(!document.getElementById("debugConsole").classList.contains("open"));
        }
        document.getElementById("debugToggleBtn").addEventListener("click", toggleDebugConsole);
        document.getElementById("debugConsoleTab").addEventListener("click", toggleDebugConsole);
        document.getElementById("debugConsoleClose").addEventListener("click", () => setDebugConsole(false));

        document.getElementById("wllamaDebugClear").addEventListener("click", () => {
            const panel = document.getElementById("wllamaDebugLog");
            if (panel) panel.textContent = "";
        });

        // Without JSPI (WebAssembly.Suspending — Firefox < 153, Safari) wllama can't
        // stream-load GGUFs and instead copies the whole file into its 4 GiB wasm heap,
        // where oversized allocations fail unchecked ("source array is too long").
        // Capability-based, not browser-sniffing: Firefox 153+ passes the JSPI check.
        const WLLAMA_HAS_JSPI = typeof WebAssembly !== "undefined" && !!WebAssembly.Suspending;
        const WLLAMA_HAS_WEBGPU = !!navigator.gpu;
        // Heap is 4 GiB; leave headroom for KV cache and compute buffers.
        const WLLAMA_NO_JSPI_MAX_BYTES = 3 * 1024 * 1024 * 1024;

        (function renderWllamaCapabilityHint() {
            const warnings = [];
            if (!WLLAMA_HAS_JSPI) warnings.push("⚠️ This browser can't stream-load models (no WebAssembly JSPI) — GGUF files over ~3 GB will fail. Use Chrome/Edge or Firefox 153+.");
            if (!WLLAMA_HAS_WEBGPU) warnings.push("⚠️ WebGPU is unavailable — inference will run on CPU only (slower).");
            if (warnings.length) {
                const el = document.getElementById("wllamaCapabilityHint");
                el.textContent = warnings.join(" ");
                el.style.display = "block";
            }
        })();

        // Returns an error message when the model can't fit this browser's wasm heap,
        // else null. Checked before loading a local file and before streaming a download.
        function wllamaPreflightSize(bytes) {
            if (!WLLAMA_HAS_JSPI && bytes >= WLLAMA_NO_JSPI_MAX_BYTES) {
                return `This model is ${(bytes / 1073741824).toFixed(1)} GB, but without WebAssembly JSPI this browser must fit the whole file into a 4 GB WASM heap and the load will fail. Use Chrome/Edge or Firefox 153+, or pick a smaller quantization.`;
            }
            return null;
        }

        // Disable every model-loading control while a load/download is in flight
        // (both entry points share the engine instance, so no concurrency allowed).
        function setWllamaLoadBusy(busy) {
            document.getElementById("settingWllamaFile").disabled = busy;
            document.getElementById("settingWllamaUrl").disabled = busy;
            document.getElementById("wllamaUrlLoadBtn").disabled = busy;
        }

        // Shared load path for both entry points (local file picker and by-URL
        // download). `blobs` is what wllama's loadModel expects; `label` is only
        // used for status messages. Errors are reported in the status line and
        // debug console rather than thrown.
        async function loadWllamaModel(blobs, label) {
            const statusEl = document.getElementById("wllamaStatus");
            const pbContainer = document.getElementById("wllamaProgressBarContainer");
            const pbBar = document.getElementById("wllamaProgressBar");
            statusEl.textContent = "Status: Loading Engine...";
            pbContainer.style.display = "block";
            pbBar.className = "pb-indeterminate";
            pbBar.style.width = "50%";

            // Chrome restricts module workers created from cross-origin redirected scripts
            // (like our jsdelivr import). Since Wllama's worker doesn't actually use ES module
            // features (it's a massive string literal), we can intercept the Worker constructor
            // and strip { type: "module" } to bypass Chrome's block. The patch is scoped to
            // this load and restored in the finally below so other workers are unaffected.
            const OriginalWorker = window.Worker;
            window.Worker = function(url, options) {
                if (options && options.type === "module") {
                    options = Object.assign({}, options);
                    delete options.type;
                }
                return new OriginalWorker(url, options);
            };

            try {
                const engine = await resolveWllamaEngine();
                if (!WllamaClass) {
                    wllamaLog("log", `Loading wllama engine from ${engine.source}…`);
                    const module = await import(engine.js);
                    WllamaClass = module.Wllama;
                }

                // Flush the previous engine's RAM/VRAM before initializing a new one.
                if (wllamaInstance) {
                    wllamaLog("log", "Unloading previous model…");
                    try { await wllamaInstance.exit(); }
                    catch (exitErr) { wllamaLog("warn", "Engine cleanup failed:", exitErr.message || exitErr); }
                    wllamaInstance = null;
                }

                statusEl.textContent = "Status: Initializing Wllama...";
                wllamaLog("log", "Initializing Wllama engine…");
                wllamaInstance = new WllamaClass(
                    { "default": engine.wasm },
                    {
                        // Route wllama's internal messages into the debug panel.
                        logger: {
                            debug: (...a) => wllamaLog("debug", "[core]", ...a),
                            log:   (...a) => wllamaLog("log",   "[core]", ...a),
                            warn:  (...a) => wllamaLog("warn",  "[core]", ...a),
                            error: (...a) => wllamaLog("error", "[core]", ...a),
                        },
                        // Native llama.cpp logs (context/KV cache/backend init/timings) are
                        // the noisiest, so only let them through when Debug verbosity is set at
                        // load time (change the level and reload the model to toggle them).
                        suppressNativeLog: wllamaVerbosity() < WLLAMA_LOG_RANK.debug,
                    }
                );
                const useWebGpu = document.getElementById("wllamaWebGpuToggle").checked;
                const loadOptions = useWebGpu ? {} : { n_gpu_layers: 0 };
                // 0 (or blank) leaves n_ctx unset so wllama uses the model's trained context.
                const nCtx = parseInt(document.getElementById("settingWllamaCtx").value, 10);
                if (Number.isFinite(nCtx) && nCtx > 0) loadOptions.n_ctx = nCtx;

                // Stream download/decode progress into the status line and debug panel.
                loadOptions.progressCallback = ({ loaded, total }) => {
                    const pct = total ? Math.round((loaded / total) * 100) : 0;
                    statusEl.textContent = `Status: Loading Model (${label}) ${pct}%`;
                    pbContainer.style.display = "block";
                    if (pct > 0 && pct < 100) {
                        pbBar.className = "";
                        pbBar.style.width = pct + "%";
                        pbBar.style.backgroundColor = "var(--primary)";
                        pbBar.style.transition = "width 0.1s linear";
                    } else if (pct === 100) {
                        // After loading instantly, we are usually blocking on decoding/initializing.
                        pbBar.className = "pb-indeterminate";
                        pbBar.style.width = "50%";
                    }
                    wllamaLog("debug", `load progress ${pct}% (${loaded}/${total} bytes)`);
                };
                wllamaLog("log", `Load config → WebGPU=${useWebGpu}, n_ctx=${loadOptions.n_ctx ?? "model default"}, n_gpu_layers=${loadOptions.n_gpu_layers ?? "auto (all)"}`);

                statusEl.textContent = `Status: Loading Model (${label})...`;
                pbContainer.style.display = "block";
                pbBar.className = "pb-indeterminate";
                pbBar.style.width = "50%";
                const loadStart = performance.now();
                await wllamaInstance.loadModel(blobs, loadOptions);
                wllamaLog("log", `Model loaded in ${((performance.now() - loadStart) / 1000).toFixed(1)}s`);

                // Inspect metadata so Auto mode can prefer the embedded template and,
                // failing that, guess a sane format from the model architecture.
                wllamaHasEmbeddedTemplate = false;
                wllamaDetectedTemplate = "zephyr";
                try {
                    const meta = await wllamaInstance.getModelMetadata();
                    const m = meta?.meta || meta || {};
                    wllamaHasEmbeddedTemplate = !!m["tokenizer.chat_template"];
                    wllamaDetectedTemplate = detectTemplateFromArch(m["general.architecture"]);
                    wllamaLog("log", `Metadata → arch=${m["general.architecture"] || "?"}, name=${m["general.name"] || "?"}, embedded_template=${wllamaHasEmbeddedTemplate}, detected_format=${wllamaDetectedTemplate}`);
                    wllamaLog("debug", "Full model metadata:", m);
                } catch (metaErr) {
                    wllamaLog("warn", "Could not read model metadata:", metaErr.message || metaErr);
                }
                const detail = wllamaHasEmbeddedTemplate
                    ? "embedded template"
                    : `auto: ${wllamaDetectedTemplate}`;
                statusEl.textContent = `Status: Ready 🟢 (${detail})`;
                pbContainer.style.display = "none";
                // A loaded model means in-browser mode: commit it and refresh the
                // header so the overlay shows the GGUF instead of the remote API.
                backendMode = "wllama";
                wllamaModelLabel = label;
                updateOverlay();
                updateMainCloudWarning();
                if (wllamaHashLoadPending) {
                    // Banner-initiated load: drop the user straight into the chat.
                    wllamaHashLoadPending = false;
                    settingsModal.classList.remove("active");
                    showToast(`🟢 ${label} loaded — start chatting!`);
                }
            } catch (err) {
                wllamaHashLoadPending = false; // keep the modal open so the error is visible
                wllamaLog("error", "Load failed:", err.message || err);
                let msg = err.message || String(err);
                // wllama doesn't check its heap allocations; an oversized model surfaces
                // as a raw TypedArray.set RangeError (wording differs per browser).
                if (err instanceof RangeError || /source array is too long|is out of bounds/i.test(msg)) {
                    msg = "the model doesn't fit in browser memory."
                        + (WLLAMA_HAS_JSPI ? "" : " Without WebAssembly JSPI this browser caps models at ~3 GB — use Chrome/Edge or Firefox 153+.")
                        + " Try a smaller quantization.";
                }
                statusEl.textContent = "Status: Error - " + msg;
                pbContainer.style.display = "none";
            } finally {
                window.Worker = OriginalWorker;
            }
        }

        document.getElementById("settingWllamaFile").addEventListener("change", async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const sizeErr = wllamaPreflightSize(file.size);
            if (sizeErr) {
                wllamaLog("error", sizeErr);
                document.getElementById("wllamaStatus").textContent = "Status: Error - " + sizeErr;
                e.target.value = "";
                return;
            }
            setWllamaLoadBusy(true);
            try { await loadWllamaModel([file], file.name); }
            finally { setWllamaLoadBusy(false); }
        });

        // Accept the three URL shapes people realistically paste and normalize them
        // to a direct, CORS-enabled download link. Throws with a human hint otherwise.
        function normalizeGgufUrl(raw) {
            let url = (raw || "").trim();
            if (!url) throw new Error("Enter a model URL first.");
            const hf = url.match(/^hf:\/{0,2}([^\/\s]+)\/([^\/\s]+)\/(\S+\.gguf)$/i);
            if (hf) url = `https://huggingface.co/${hf[1]}/${hf[2]}/resolve/main/${hf[3]}`;
            if (!/^https?:\/\//i.test(url)) throw new Error("Not a URL. Use https://… or the hf:user/repo/file.gguf shorthand.");
            // Hugging Face "blob" browser pages aren't downloadable; the same path under /resolve/ is.
            if (/^https:\/\/huggingface\.co\//i.test(url)) url = url.replace(/\/blob\//, "/resolve/");
            if (!/\.gguf(\?.*)?$/i.test(url)) throw new Error("URL must point directly to a single .gguf file.");
            if (/-\d{5}-of-\d{5}\.gguf(\?.*)?$/i.test(url)) throw new Error("Split GGUFs (…-00001-of-000NN.gguf) aren't supported — pick a single-file quant.");
            return url;
        }

        // Stream the GGUF into memory (never into browser storage — ephemerality is a
        // hard project rule, and wllama's own URL loader would persist it to OPFS).
        // The blob then goes through the exact same loadModel path as a local file.
        async function downloadGgufToBlob(url, onProgress) {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
            const total = parseInt(res.headers.get("content-length") || "0", 10);
            // Fail before pulling gigabytes the engine can't load anyway.
            const sizeErr = wllamaPreflightSize(total);
            if (sizeErr) {
                try { await res.body.cancel(); } catch { /* already closed */ }
                throw new Error(sizeErr);
            }
            const reader = res.body.getReader();
            const chunks = [];
            let loaded = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                loaded += value.byteLength;
                onProgress({ loaded, total });
            }
            return new Blob(chunks);
        }

        async function loadWllamaModelFromUrl() {
            const statusEl = document.getElementById("wllamaStatus");
            const pbContainer = document.getElementById("wllamaProgressBarContainer");
            const pbBar = document.getElementById("wllamaProgressBar");
            let url;
            try {
                url = normalizeGgufUrl(document.getElementById("settingWllamaUrl").value);
            } catch (err) {
                statusEl.textContent = "Status: " + err.message;
                return;
            }
            const label = decodeURIComponent(url.split("?")[0].split("/").pop());
            setWllamaLoadBusy(true);
            try {
                wllamaLog("log", `Downloading model from ${url}`);
                pbContainer.style.display = "block";
                pbBar.className = "pb-indeterminate";
                pbBar.style.width = "50%";
                const fmtMB = b => (b / 1048576).toFixed(0) + " MB";
                const downloadStart = performance.now();
                const blob = await downloadGgufToBlob(url, ({ loaded, total }) => {
                    if (total > 0) {
                        const pct = Math.round((loaded / total) * 100);
                        statusEl.textContent = `Status: Downloading ${label} ${pct}% (${fmtMB(loaded)} / ${fmtMB(total)})`;
                        pbBar.className = "";
                        pbBar.style.width = pct + "%";
                        pbBar.style.backgroundColor = "var(--primary)";
                        pbBar.style.transition = "width 0.1s linear";
                    } else {
                        statusEl.textContent = `Status: Downloading ${label} (${fmtMB(loaded)})`;
                    }
                });
                wllamaLog("log", `Downloaded ${fmtMB(blob.size)} in ${((performance.now() - downloadStart) / 1000).toFixed(1)}s`);
                await loadWllamaModel([blob], label);
            } catch (err) {
                wllamaHashLoadPending = false; // keep the modal open so the error is visible
                wllamaLog("error", "Download failed:", err.message || err);
                const hint = err instanceof TypeError
                    ? " (network/CORS blocked — make sure it's a direct /resolve/ link to a public file)"
                    : "";
                statusEl.textContent = "Status: Error - " + (err.message || err) + hint;
                pbContainer.style.display = "none";
            } finally {
                setWllamaLoadBusy(false);
            }
        }
        document.getElementById("wllamaUrlLoadBtn").addEventListener("click", loadWllamaModelFromUrl);
        document.getElementById("settingWllamaUrl").addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); loadWllamaModelFromUrl(); }
        });

        // Hash-config hook, called by applyHashConfig() when a #gguf=… param is
        // present. It only prefills and shows a confirmation banner — a shared
        // link must never start a multi-GB download without one explicit click.
        function handleWllamaHashParams(params) {
            const raw = (params.get("gguf") || "").trim();
            if (!raw) return;
            let url;
            try {
                url = normalizeGgufUrl(raw);
            } catch (err) {
                showToast(`🔗 gguf link ignored: ${err.message}`);
                return;
            }
            document.getElementById("settingWllamaUrl").value = url;
            document.getElementById("wllamaHashModelName").textContent = decodeURIComponent(url.split("?")[0].split("/").pop());
            document.getElementById("wllamaHashHost").textContent = new URL(url).host;
            document.getElementById("wllamaHashBanner").style.display = "flex";
        }
        document.getElementById("wllamaHashLoadBtn").addEventListener("click", () => {
            document.getElementById("wllamaHashBanner").style.display = "none";
            backendMode = "wllama";
            wllamaHashLoadPending = true; // auto-close settings once the model is ready
            // Open settings so the existing status line and progress bar are
            // visible, then reuse the normal URL-load path.
            document.getElementById("settingsBtn").click();
            loadWllamaModelFromUrl();
        });
        document.getElementById("wllamaHashDismissBtn").addEventListener("click", () => {
            document.getElementById("wllamaHashBanner").style.display = "none";
        });
        // @wllama:end
        // ========== New Chat ==========
        document.getElementById("clearBtn").addEventListener("click", () => {
            if (isWaiting) return; // Don't clear during generation
            // New chat inherits current active persona
            messages = [{"role": "system", "content": SYSTEM_PROMPT}];
            showEmptyState();
            updateGlobalStats("0", "0", "0.0", "0.0");
        });

        let toastTimeout = null;
        function showToast(message) {
            let toast = document.getElementById("toastNotification");
            if (!toast) {
                toast = document.createElement("div");
                toast.id = "toastNotification";
                toast.className = "toast";
                document.body.appendChild(toast);
            }
            toast.textContent = message;
            toast.classList.add("show");
            if (toastTimeout) clearTimeout(toastTimeout);
            toastTimeout = setTimeout(() => toast.classList.remove("show"), 2500);
        }

        // ========== Vision capability detection (best-effort) ==========
        // Models the server explicitly reports as accepting image input.
        const VISION_MODELS = new Set();
        // Name heuristic for backends that don't report modalities (OpenAI, most llama.cpp, etc.).
        const VISION_NAME_RE = /gpt-4o|gpt-4\.1|gpt-5|vision|claude-3|claude-[45]|gemini|llava|bakllava|moondream|pixtral|internvl|-vl\b|qwen.*vl|minicpm-v|smolvlm|granite.*vision/i;

        // Flatten a message's content (string or multimodal array) to plain text.
        function contentToText(content) {
            if (Array.isArray(content)) {
                const parts = content.filter(p => p.type === "text").map(p => p.text);
                const imgCount = content.filter(p => p.type === "image_url").length;
                let out = parts.join(" ");
                if (imgCount > 0) out += (out ? " " : "") + `[${imgCount} image${imgCount > 1 ? "s" : ""} attached]`;
                return out;
            }
            return content == null ? "" : String(content);
        }

        function extractModelId(m) {
            return (m && (m.id || m.name)) || m;
        }
        // Read any non-standard modality hints a server may expose.
        function modelReportsVision(m) {
            if (!m || typeof m !== "object") return false;
            const modalities = (m.architecture && m.architecture.input_modalities) || m.input_modalities || m.modalities;
            if (Array.isArray(modalities) && modalities.some(x => /image|vision/i.test(String(x)))) return true;
            if (Array.isArray(m.capabilities) && m.capabilities.some(x => /vision|image/i.test(String(x)))) return true;
            return false;
        }
        function modelSupportsVision(id) {
            if (!id) return false;
            return VISION_MODELS.has(id) || VISION_NAME_RE.test(id);
        }
        function currentSettingsModel() {
            const select = document.getElementById("settingModelSelect");
            const input = document.getElementById("settingModelInput");
            if (select && select.style.display !== "none" && select.value && select.value !== "custom") return select.value;
            return input ? input.value.trim() : "";
        }
        function updateVisionBadge() {
            const badge = document.getElementById("visionBadge");
            if (!badge) return;
            badge.style.display = modelSupportsVision(currentSettingsModel()) ? "inline-block" : "none";
        }

        // ========== Test Connection & Fetch Models ==========
        document.getElementById("testConnectionBtn").addEventListener("click", async (e) => {
            e.preventDefault();
            const btn = document.getElementById("testConnectionBtn");
            const originalText = btn.innerHTML;
            btn.innerHTML = "⏳ Testing...";
            btn.disabled = true;

            try {
                let currentUrl = document.getElementById("settingUrl").value.trim();
                let currentKey = document.getElementById("settingApiKey").value.trim();
                
                let modelsUrl = currentUrl.trim().replace(/\/+$/, "");
                if (modelsUrl.endsWith("/chat/completions")) {
                    modelsUrl = modelsUrl.replace("/chat/completions", "/models");
                } else if (!modelsUrl.endsWith("/models")) {
                    modelsUrl = modelsUrl + "/models";
                }

                const response = await fetch(modelsUrl, {
                    method: "GET",
                    headers: { "Authorization": "Bearer " + currentKey }
                });

                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                
                const data = await response.json();
                let models = data.data || [];
                if (!Array.isArray(models)) {
                    models = Array.isArray(data) ? data : (data.models || []);
                }

                if (models.length === 0) throw new Error("No models found in response.");

                const select = document.getElementById("settingModelSelect");
                const input = document.getElementById("settingModelInput");

                select.innerHTML = "";
                VISION_MODELS.clear();
                models.forEach(m => {
                    const modelId = extractModelId(m);
                    if (modelReportsVision(m)) VISION_MODELS.add(modelId);
                    const opt = document.createElement("option");
                    opt.value = modelId;
                    opt.textContent = modelId;
                    select.appendChild(opt);
                });

                const customOpt = document.createElement("option");
                customOpt.value = "custom";
                customOpt.textContent = "✍️ Custom / Manual Entry";
                select.appendChild(customOpt);

                const currentModelVal = input.value.trim();
                let match = Array.from(select.options).find(o => o.value === currentModelVal);
                if (match) {
                    select.value = currentModelVal;
                }

                input.style.display = "none";
                select.style.display = "block";
                updateVisionBadge();

                showToast(`✅ Connection successful! Found ${models.length} models.`);
            } catch (error) {
                console.error("Test connection failed:", error);
                showToast(`❌ Connection failed: ${error.message}`);
            } finally {
                btn.innerHTML = originalText;
                btn.disabled = false;
            }
        });

        document.getElementById("settingModelSelect").addEventListener("change", (e) => {
            if (e.target.value === "custom") {
                e.target.style.display = "none";
                const input = document.getElementById("settingModelInput");
                input.style.display = "block";
                input.focus();
            }
            updateVisionBadge();
        });
        document.getElementById("settingModelInput").addEventListener("input", updateVisionBadge);

        // ========== Export Chat ==========
        document.getElementById("exportBtn").addEventListener("click", () => {
            let md = "# Chat Export\n\n";
            for (const msg of messages) {
                if (msg.role === "system") {
                    md += `> **System:** ${msg.content.replace(/\n/g, '\n> ')}\n\n---\n\n`;
                } else if (msg.role === "user") {
                    md += `## 🧑‍💻 You\n\n<div class="user-message">\n\n${contentToText(msg.content)}\n\n</div>\n\n`;
                } else if (msg.role === "assistant") {
                    md += `## ✨ AI\n\n<div class="ai-message">\n\n${contentToText(msg.content)}\n\n</div>\n\n---\n\n`;
                }
            }
            const blob = new Blob([md], { type: "text/markdown" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `chat-export-${new Date().toISOString().slice(0,16).replace(/[T:]/g, "-")}.md`;
            a.click();
            URL.revokeObjectURL(a.href);
            showToast("✅ Chat exported!");
        });

        // ========== Summarize Chat ==========
        document.getElementById("summarizeBtn").addEventListener("click", async () => {
            if (isWaiting) return;
            const hasUserMessage = messages.some(m => m.role === "user");
            if (!hasUserMessage) {
                showToast("⚠️ Nothing to summarize yet!");
                return;
            }

            // Build the transcript
            let transcript = "";
            for (const msg of messages) {
                if (msg.isSummary) continue;
                if (msg.role === "user") transcript += `User: ${contentToText(msg.content)}\n\n`;
                else if (msg.role === "assistant") transcript += `AI: ${contentToText(msg.content)}\n\n`;
            }

            const summaryPrompt = `Summarize the following conversation:\n\n${transcript}`;
            
            // UI update
            inputField.disabled = true;
            sendBtn.style.display = "none";
            stopBtn.style.display = "flex";
            isWaiting = true;
            userScrolledUp = false;
            abortController = new AbortController();

            const responseContainerId = appendMessage("AI", "", "summary", "📋");
            const responseContainer = document.getElementById(responseContainerId);
            
            responseContainer.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                    <div class="summary-badge" style="margin-bottom: 0;">Summary</div>
                    <button class="action-btn copy-summary-btn" style="color: var(--primary); font-weight: 600; font-size: 0.75rem; padding: 2px 6px;">📋 Copy</button>
                </div>
                <div class="ai-response-body"></div>
            `;
            
            let ctx = {
                aiReasoning: "",
                fullRawText: "",
                startTime: Date.now(),
                responseContainer: responseContainer.querySelector('.ai-response-body')
            };
            let promptTokens = 0;
            let completionTokens = 0;

            const throttledRender = createThrottle(CONSTANTS.THROTTLE_MS);

            document.getElementById('chatForm').classList.add('is-generating');
            responseContainer.classList.add('cursor');

            await fetchAndStreamChat({
                model: MODEL_NAME,
                messages: [
                    {"role": "system", "content": "You are a concise summarization assistant. Your output is rendered as Markdown.\n\nOutput format:\n## TL;DR\nOne-sentence summary.\n\n## Key Topics\n- Bulleted list of main subjects discussed.\n\n## Conclusions & Answers\n- Bulleted list of decisions, solutions, or answers reached. If the conversation is primarily code or debugging, include the specific technical solution or fix here.\n\n## Action Items\n- Bulleted list (or \"None\" if no action items were identified).\n\nKeep the summary proportional: 50-100 words for short conversations, up to 300 for longer ones."},
                    {"role": "user", "content": summaryPrompt}
                ],
                temperature: 0.3,
                stream: true,
                stream_options: { include_usage: true }
            }, abortController.signal, {
                onChunk: (reasoningChunk, contentChunk, pt, ct) => {
                    if (reasoningChunk) ctx.aiReasoning += reasoningChunk;
                    if (contentChunk) ctx.fullRawText += contentChunk;
                    promptTokens = pt;
                    completionTokens = ct;
                    throttledRender(() => { updateMessageUI(ctx, false); });
                },
                onDone: (pt, ct) => {
                    promptTokens = pt;
                    completionTokens = ct;
                    updateMessageUI(ctx, true);
                    messages.push({"role": "assistant", "content": "## Summary\n\n" + buildFinalHistory(ctx.fullRawText, ctx.aiReasoning), "isSummary": true});
                    finishGeneration();
                },
                onError: (error) => {
                    if (error.name !== 'AbortError') {
                        responseContainer.innerHTML += `<br><span style='color:#ef4444;'>❌ ${DOMPurify.sanitize(error.message)}</span>`;
                    }
                    finishGeneration();
                }
            });

            function finishGeneration() {
                throttledRender.cancel();
                document.getElementById('chatForm').classList.remove('is-generating');
                responseContainer.classList.remove('cursor');
                sendBtn.style.display = "flex";
                stopBtn.style.display = "none";
                inputField.disabled = false;
                isWaiting = false;
                inputField.focus();
                let durationSec = (Date.now() - ctx.startTime) / 1000;
                if (completionTokens === 0) completionTokens = Math.ceil(ctx.fullRawText.length / 4);
                if (promptTokens === 0) promptTokens = Math.ceil(summaryPrompt.length / 4);
                let tps = completionTokens > 0 ? (completionTokens / durationSec).toFixed(1) : "0.0";
                if (typeof updateGlobalStats === 'function') updateGlobalStats(promptTokens, completionTokens, tps, durationSec.toFixed(1));
                const copyBtn = responseContainer.querySelector(".copy-summary-btn");
                if (copyBtn) {
                    copyBtn.addEventListener("click", () => {
                        navigator.clipboard.writeText(ctx.fullRawText).then(() => {
                            copyBtn.textContent = "✅ Copied!";
                            setTimeout(() => { copyBtn.textContent = "📋 Copy"; }, 2000);
                        });
                    });
                }
            }
        });

        function injectCopyButtons(container) {
            container.querySelectorAll("pre").forEach((pre) => {
                if (pre.querySelector(".code-copy-btn")) return; // Already has one
                
                const code = pre.querySelector("code");
                if (code && code.className) {
                    const match = code.className.match(/language-(\w+)/);
                    if (match) {
                        const langLabel = document.createElement("div");
                        langLabel.className = "code-lang-label";
                        langLabel.textContent = match[1];
                        pre.appendChild(langLabel);
                    }
                }

                const btn = document.createElement("button");
                btn.className = "code-copy-btn";
                btn.textContent = "Copy";
                btn.addEventListener("click", () => {
                    const code = pre.querySelector("code");
                    navigator.clipboard.writeText(code ? code.textContent : pre.textContent).then(() => {
                        btn.textContent = "Copied!";
                        btn.classList.add("copied");
                        setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 2000);
                    });
                });
                pre.appendChild(btn);
            });
        }

        // ========== Throttle Utility ==========
        function createThrottle(minInterval) {
            let lastRun = 0;
            let pending = null;
            let lastFn = null;
            function throttled(fn) {
                lastFn = fn;
                const now = Date.now();
                if (now - lastRun >= minInterval) {
                    lastRun = now;
                    fn();
                    if (pending) { clearTimeout(pending); pending = null; }
                } else if (!pending) {
                    pending = setTimeout(() => {
                        lastRun = Date.now();
                        pending = null;
                        if (lastFn) lastFn();
                    }, minInterval - (now - lastRun));
                }
            }
            // Cancel a scheduled trailing call so it can't fire after the final render.
            throttled.cancel = function() {
                if (pending) { clearTimeout(pending); pending = null; }
            };
            return throttled;
        }

        // ========== Think-Tag Parser ==========
        function parseThinkSegments(rawText) {
            let segments = [];
            let currentIdx = 0;
            const openRegex = /<\|?(?:think|thought|reasoning|thought_start)[^>]*>/gi;
            const closeRegex = /<\/?\|?(?:think|thought|reasoning|thought_end)[^>]*>/gi;

            while (true) {
                openRegex.lastIndex = currentIdx;
                let openMatch = openRegex.exec(rawText);
                
                if (!openMatch) {
                    let textContent = rawText.substring(currentIdx);
                    const partials = ['<think', '<thought', '<reasoning', '<|thought_start', '<|thought_end'];
                    const lowerContent = textContent.toLowerCase();
                    for (let p of partials) {
                        let found = false;
                        for (let i = p.length - 1; i >= 1; i--) {
                            if (lowerContent.endsWith(p.substring(0, i))) {
                                textContent = textContent.substring(0, textContent.length - i);
                                found = true;
                                break;
                            }
                        }
                        if (found) break;
                    }
                    if (textContent.length > 0) {
                        segments.push({ type: 'text', content: textContent });
                    }
                    break;
                }

                let textBefore = rawText.substring(currentIdx, openMatch.index);
                if (textBefore.length > 0) {
                    segments.push({ type: 'text', content: textBefore });
                }

                closeRegex.lastIndex = openMatch.index + openMatch[0].length;
                let closeMatch = closeRegex.exec(rawText);

                if (closeMatch) {
                    let thinkContent = rawText.substring(openMatch.index + openMatch[0].length, closeMatch.index);
                    segments.push({ type: 'think', content: thinkContent, isClosed: true });
                    currentIdx = closeMatch.index + closeMatch[0].length;
                } else {
                    let thinkContent = rawText.substring(openMatch.index + openMatch[0].length);
                    segments.push({ type: 'think', content: thinkContent, isClosed: false });
                    break;
                }
            }
            return segments;
        }

        // ========== UI Render Helper ==========
        function updateMessageUI(ctx, isFinal) {
            let parsedSegments = parseThinkSegments(ctx.fullRawText);
            
            if (ctx.aiReasoning) {
                parsedSegments.unshift({
                    type: 'think',
                    content: ctx.aiReasoning,
                    isClosed: ctx.fullRawText.length > 0 || isFinal
                });
            }
            
            let preText = [];
            let thinkContents = [];
            let postText = [];
            let hasThink = false;
            let anyThinkUnclosed = false;

            for (const seg of parsedSegments) {
                if (seg.type === 'think') {
                    hasThink = true;
                    if (seg.content) thinkContents.push(seg.content);
                    if (!seg.isClosed) anyThinkUnclosed = true;
                } else if (seg.type === 'text') {
                    if (!hasThink) {
                        preText.push(seg.content);
                    } else {
                        postText.push(seg.content);
                    }
                }
            }
            
            let segments = [];
            if (preText.length > 0) {
                segments.push({ type: 'text', content: preText.join('') });
            }
            if (hasThink) {
                segments.push({
                    type: 'think',
                    content: thinkContents.join('\n\n'),
                    isClosed: !anyThinkUnclosed
                });
            }
            if (postText.length > 0) {
                segments.push({ type: 'text', content: postText.join('') });
            }
            
            if (!ctx.domSegments) ctx.domSegments = [];
            
            // Validate DOM sync just in case
            let needsRebuild = false;
            for (let i = 0; i < Math.min(segments.length, ctx.domSegments.length); i++) {
                if (segments[i].type !== ctx.domSegments[i].type) {
                    needsRebuild = true;
                    break;
                }
            }
            
            if (needsRebuild) {
                ctx.responseContainer.innerHTML = '';
                ctx.domSegments = [];
                if (ctx.typingIndicator) ctx.typingIndicator.remove();
                ctx.typingIndicator = null;
            }
            
            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                let domSeg = ctx.domSegments[i];
                
                if (!domSeg) {
                    if (seg.type === 'text') {
                        const div = document.createElement('div');
                        div.className = 'text-content';
                        if (ctx.responseContainer.children.length > 0) div.style.marginTop = '12px';
                        ctx.responseContainer.appendChild(div);
                        domSeg = { type: 'text', el: div };
                    } else if (seg.type === 'think') {
                        const details = document.createElement('details');
                        details.className = 'think-block';
                        details.open = true;
                        
                        const summary = document.createElement('summary');
                        summary.textContent = '🧠 Thinking Process';
                        details.appendChild(summary);
                        
                        const content = document.createElement('div');
                        content.className = 'think-content';
                        details.appendChild(content);
                        
                        ctx.responseContainer.appendChild(details);
                        domSeg = { type: 'think', el: details, summaryEl: summary, contentEl: content, hasAutoClosed: false };
                    }
                    ctx.domSegments.push(domSeg);
                }
                
                if (seg.type === 'text') {
                    domSeg.el.innerHTML = DOMPurify.sanitize(marked.parse(seg.content));
                } else if (seg.type === 'think') {
                    domSeg.contentEl.textContent = seg.content.replace(/^\s+/, "");
                    
                    let isThinkingActive = !seg.isClosed && !isFinal;
                    
                    if (seg.isClosed && !domSeg.hasAutoClosed) {
                        domSeg.el.open = false;
                        domSeg.hasAutoClosed = true;
                    }
                    
                    if (isThinkingActive) {
                        let thinkDuration = Math.floor((Date.now() - ctx.startTime) / 1000);
                        domSeg.el.classList.add("thinking-active");
                        domSeg.summaryEl.textContent = `🧠 Thinking Process (${thinkDuration}s)`;
                    } else {
                        domSeg.el.classList.remove("thinking-active");
                        let finalDurationText = domSeg.summaryEl.textContent.match(/\(\d+s\)/);
                        domSeg.summaryEl.textContent = `🧠 Thinking Process ${finalDurationText ? finalDurationText[0] : ''}`;
                    }
                }
            }
            
            while (ctx.domSegments.length > segments.length) {
                const extra = ctx.domSegments.pop();
                extra.el.remove();
            }
            
            if (!ctx.typingIndicator) {
                ctx.typingIndicator = document.createElement('div');
                ctx.typingIndicator.className = 'typing-indicator';
                ctx.typingIndicator.innerHTML = '<span></span><span></span><span></span>';
                ctx.typingIndicator.style.marginTop = '8px';
            }
            
            if (isFinal) {
                if (ctx.typingIndicator.parentNode) ctx.typingIndicator.remove();
            } else {
                ctx.responseContainer.appendChild(ctx.typingIndicator);
            }
            
            injectCopyButtons(ctx.responseContainer);

            // Diagrams only render once the message is complete; while streaming the
            // fence stays visible as a plain code block.
            if (isFinal) renderMermaidBlocks(ctx.responseContainer);

            if (!userScrolledUp) {
                chatbox.scrollTop = chatbox.scrollHeight;
            }
        }

        // ========== Helper: build history content preserving reasoning ==========
        function buildFinalHistory(fullRawText, aiReasoning) {
            let finalContent = fullRawText;
            if (aiReasoning && !/<(?:\|?)(?:think|thought|reasoning|thought_start)/i.test(fullRawText)) {
                finalContent = `<think>\n${aiReasoning}\n</think>\n${fullRawText}`;
            }
            return finalContent;
        }

        // @wllama:start
        // ========== In-Browser Inference (wllama) ==========
        const WLLAMA_CDN_BASE = "https://cdn.jsdelivr.net/npm/@wllama/wllama@3.5.1/esm";
        let backendMode = "api";
        let WllamaClass = null;
        let wllamaInstance = null;
        let wllamaHasEmbeddedTemplate = false; // GGUF ships tokenizer.chat_template
        let wllamaDetectedTemplate = "zephyr"; // auto-detected fallback format
        let wllamaModelLabel = null; // filename of the currently loaded GGUF
        let wllamaHashLoadPending = false; // load came from the #gguf confirmation banner

        // In wllama mode the header overlay and the cloud-provider warning would
        // describe the (unused) remote API — misleading when inference is fully
        // in-browser. Wrap both; the stripped builds keep the originals untouched.
        const apiUpdateOverlay = updateOverlay;
        updateOverlay = function () {
            if (backendMode !== "wllama") { apiUpdateOverlay(); return; }
            document.getElementById("overlayModel").textContent = wllamaModelLabel || "no model loaded";
            document.getElementById("overlayUrl").textContent = "in-browser (wllama)";
        };
        const apiUpdateMainCloudWarning = updateMainCloudWarning;
        updateMainCloudWarning = function () {
            if (backendMode !== "wllama") { apiUpdateMainCloudWarning(); return; }
            document.getElementById("mainScreenCloudWarning").style.display = "none";
        };

        // The dedicated wllama build embeds the engine (gzip + base64, injected by
        // build.py as window.__WLLAMA_INLINE__) so model loading needs zero network
        // access. Without the injection (unbuilt dev source) the engine comes from
        // the pinned CDN instead. Inflation reuses the shared gunzipToBytes helper.
        let wllamaEngineUrls = null; // resolved once; module imports cache per URL
        function bytesToBase64(bytes) {
            let bin = "";
            for (let i = 0; i < bytes.length; i += 0x8000) {
                bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            }
            return btoa(bin);
        }
        async function resolveWllamaEngine() {
            if (wllamaEngineUrls) return wllamaEngineUrls;
            const inline = window.__WLLAMA_INLINE__;
            if (inline) {
                const jsBytes = await gunzipToBytes(inline.js);
                // The wasm must be a data: URI with exactly this MIME prefix — Emscripten's
                // loader decodes it in-place, whereas a blob: URL from a file:// page
                // (origin "null") is not XHR-loadable inside wllama's worker.
                wllamaEngineUrls = {
                    js: URL.createObjectURL(new Blob([jsBytes], { type: "text/javascript" })),
                    wasm: "data:application/octet-stream;base64," + bytesToBase64(await gunzipToBytes(inline.wasm)),
                    source: "inline (offline)",
                };
            } else {
                wllamaEngineUrls = {
                    js: `${WLLAMA_CDN_BASE}/index.js`,
                    wasm: `${WLLAMA_CDN_BASE}/wasm/wllama.wasm`,
                    source: "CDN",
                };
            }
            return wllamaEngineUrls;
        }

        // Debug logging: mirror to the browser console AND stream into the in-UI panel
        // so users can watch engine/model/generation internals without opening devtools.
        const WLLAMA_LOG_COLORS = { debug: "#8b949e", log: "#c9d1d9", warn: "#e3b341", error: "#f85149" };
        // Severity rank per level; a message shows only if its rank <= the selected
        // verbosity threshold (Off=0, Errors=1, Warnings=2, Info=3, Debug=4).
        const WLLAMA_LOG_RANK = { error: 1, warn: 2, log: 3, debug: 4 };
        function wllamaVerbosity() {
            const sel = document.getElementById("wllamaVerbosity");
            return sel ? parseInt(sel.value, 10) : 3; // default: Info
        }
        function wllamaLog(level, ...args) {
            if ((WLLAMA_LOG_RANK[level] || 3) > wllamaVerbosity()) return; // below threshold
            const method = console[level] ? level : "log";
            console[method]("[wllama]", ...args);
            const panel = document.getElementById("wllamaDebugLog");
            if (!panel) return;
            const text = args.map(a =>
                typeof a === "string" ? a
                    : (() => { try { return JSON.stringify(a, null, 2); } catch (e) { return String(a); } })()
            ).join(" ");
            const line = document.createElement("div");
            line.style.color = WLLAMA_LOG_COLORS[level] || WLLAMA_LOG_COLORS.log;
            line.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
            panel.appendChild(line);
            panel.scrollTop = panel.scrollHeight;
        }

        // Registry of chat prompt formats for template-less GGUFs. Each entry knows how
        // to render a single message, the trailing tag that primes the assistant turn,
        // and the stop tokens that mark end-of-turn so generation doesn't run on.
        const CHAT_TEMPLATES = {
            chatml: {
                msg: m => `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`,
                tail: `<|im_start|>assistant\n`,
                stop: ["<|im_end|>"]
            },
            llama3: {
                msg: m => `<|start_header_id|>${m.role}<|end_header_id|>\n\n${m.content}<|eot_id|>`,
                tail: `<|start_header_id|>assistant<|end_header_id|>\n\n`,
                stop: ["<|eot_id|>", "<|end_of_text|>"]
            },
            mistral: {
                // Mistral has no distinct system/assistant tags; fold system into the first [INST].
                render: msgs => {
                    let out = "<s>";
                    let sys = msgs.filter(m => m.role === "system").map(m => m.content).join("\n");
                    for (const m of msgs) {
                        if (m.role === "system") continue;
                        if (m.role === "user") {
                            const u = sys ? `${sys}\n\n${m.content}` : m.content;
                            sys = "";
                            out += `[INST] ${u} [/INST]`;
                        } else if (m.role === "assistant") {
                            out += ` ${m.content}</s>`;
                        }
                    }
                    return out;
                },
                stop: ["</s>", "[INST]"]
            },
            gemma: {
                // Gemma has no system role; map assistant->model and prepend system to first user turn.
                render: msgs => {
                    let out = "";
                    let sys = msgs.filter(m => m.role === "system").map(m => m.content).join("\n");
                    for (const m of msgs) {
                        if (m.role === "system") continue;
                        const role = m.role === "assistant" ? "model" : "user";
                        let content = m.content;
                        if (role === "user" && sys) { content = `${sys}\n\n${content}`; sys = ""; }
                        out += `<start_of_turn>${role}\n${content}<end_of_turn>\n`;
                    }
                    out += `<start_of_turn>model\n`;
                    return out;
                },
                stop: ["<end_of_turn>"]
            },
            phi3: {
                msg: m => `<|${m.role}|>\n${m.content}<|end|>\n`,
                tail: `<|assistant|>\n`,
                stop: ["<|end|>", "<|endoftext|>"]
            },
            zephyr: {
                msg: m => `<|${m.role}|>\n${m.content}</s>\n`,
                tail: `<|assistant|>\n`,
                stop: ["</s>"]
            },
            alpaca: {
                render: msgs => {
                    let out = "";
                    const sys = msgs.filter(m => m.role === "system").map(m => m.content).join("\n");
                    if (sys) out += `${sys}\n\n`;
                    for (const m of msgs) {
                        if (m.role === "system") continue;
                        if (m.role === "user") out += `### Instruction:\n${m.content}\n\n`;
                        else if (m.role === "assistant") out += `### Response:\n${m.content}\n\n`;
                    }
                    out += `### Response:\n`;
                    return out;
                },
                stop: ["### Instruction:"]
            },
            raw: {
                render: msgs => msgs.map(m => m.content).join("\n") + "\n",
                stop: []
            }
        };

        // Map GGUF general.architecture -> template key. Used when the model lacks an
        // embedded chat template and the user leaves the format on "Auto".
        function detectTemplateFromArch(arch) {
            const a = (arch || "").toLowerCase();
            if (a.includes("qwen") || a.includes("yi")) return "chatml";
            if (a.includes("llama")) return "llama3"; // llama-3.x; older llama-2 users can override
            if (a.includes("mistral") || a.includes("mixtral")) return "mistral";
            if (a.includes("gemma")) return "gemma";
            if (a.includes("phi")) return "phi3";
            return "zephyr";
        }

        // Build the final prompt string + stop tokens for a given template key.
        function buildWllamaPrompt(key, msgs) {
            const t = CHAT_TEMPLATES[key] || CHAT_TEMPLATES.zephyr;
            if (t.render) return { prompt: t.render(msgs), stop: t.stop || [] };
            let prompt = msgs.map(t.msg).join("");
            prompt += t.tail || "";
            return { prompt, stop: t.stop || [] };
        }
        // @wllama:end
        // ========== Stream Fetch Helper ==========
        async function fetchAndStreamChat(payload, signal, callbacks) {
            const { onChunk, onDone, onError } = callbacks;
            // @wllama:start
            if (backendMode === "wllama") {
                if (!wllamaInstance) {
                    onError(new Error("Local model not loaded. Please select a .gguf file in settings."));
                    return;
                }
                // Local GGUF text models can't see images: flatten multimodal content
                // arrays to their text parts (contentToText notes "[N images attached]").
                if (payload.messages.some(m => Array.isArray(m.content))) {
                    wllamaLog("warn", "Image attachments are not supported by the local GGUF backend; sending text only.");
                }
                const wllamaMessages = payload.messages.map(m =>
                    Array.isArray(m.content) ? { role: m.role, content: contentToText(m.content) } : m
                );
                // Each streamed piece from wllama is one decoded token, so counting them
                // gives an exact token count and a live tokens/sec rate we compute ourselves.
                let genTokens = 0;
                const genStart = performance.now();
                const liveStatEl = document.getElementById("wllamaLiveStat");
                let lastLiveUpdate = 0;
                if (liveStatEl) liveStatEl.textContent = "⏳ generating…";
                try {
                    const onData = (chunk) => {
                        if (signal.aborted) throw new Error("AbortError");
                        const content = typeof chunk === 'string' ? chunk :
                            (chunk.choices?.[0]?.text || chunk.choices?.[0]?.delta?.content || chunk.content || "");
                        if (content) {
                            genTokens++;
                            onChunk("", content, 0, 0);
                            const now = performance.now();
                            if (liveStatEl && now - lastLiveUpdate > 200) { // throttle DOM writes
                                lastLiveUpdate = now;
                                const secs = (now - genStart) / 1000;
                                liveStatEl.textContent = `${genTokens} tok · ${secs > 0 ? (genTokens / secs).toFixed(1) : "0.0"} tok/s`;
                            }
                        }
                    };
                    const temperature = payload.temperature || 0.7;
                    // Optional sampling params (Advanced parameters) are forwarded when the
                    // payload carries them; penalties are not supported by the wllama API.
                    const sampling = {};
                    if (payload.top_p !== undefined) sampling.top_p = payload.top_p;
                    if (payload.seed !== undefined) sampling.seed = payload.seed;

                    // Resolve which format to use. "auto" prefers the model's own embedded
                    // chat template (via createChatCompletion) and only falls back to a
                    // detected/manual format for template-less GGUFs.
                    const choice = document.getElementById("settingWllamaTemplate")?.value || "auto";
                    const useEmbedded = choice === "auto" && wllamaHasEmbeddedTemplate;
                    // Output-length cap read live from settings (0/blank/invalid -> default 2048).
                    const parsedMaxTokens = parseInt(document.getElementById("settingWllamaMaxTokens")?.value, 10);
                    const maxTokens = Number.isFinite(parsedMaxTokens) && parsedMaxTokens > 0 ? parsedMaxTokens : 2048;

                    if (useEmbedded) {
                        wllamaLog("log", `Generating via embedded chat template (temp=${temperature}, max_tokens=${maxTokens}, messages=${wllamaMessages.length})`);
                        // wllama's OpenAI-compatible chat path applies the GGUF's own
                        // tokenizer.chat_template; chunks arrive as choices[0].delta.content.
                        await wllamaInstance.createChatCompletion({
                            messages: wllamaMessages,
                            max_tokens: maxTokens,
                            temperature,
                            ...sampling,
                            stream: true,
                            abortSignal: signal,
                            onData
                        });
                    } else {
                        // Manual formatting for template-less models (or an explicit user override).
                        const key = choice === "auto" ? wllamaDetectedTemplate : choice;
                        const { prompt, stop } = buildWllamaPrompt(key, wllamaMessages);
                        wllamaLog("log", `Generating via manual template "${key}" (temp=${temperature}, max_tokens=${maxTokens}, stop=${JSON.stringify(stop)})`);
                        wllamaLog("debug", "Formatted prompt sent to model:\n" + prompt);
                        await wllamaInstance.createCompletion({
                            prompt,
                            max_tokens: maxTokens,
                            temperature,
                            ...sampling,
                            stop,
                            stream: true,
                            abortSignal: signal,
                            onData
                        });
                    }

                    const genSecs = (performance.now() - genStart) / 1000;
                    const finalTps = genSecs > 0 ? (genTokens / genSecs).toFixed(1) : "0.0";
                    if (liveStatEl) liveStatEl.textContent = `${genTokens} tok · ${finalTps} tok/s`;
                    wllamaLog("log", `Generation done: ${genTokens} tokens in ${genSecs.toFixed(1)}s (${finalTps} tok/s)`);
                    onDone(0, genTokens);
                } catch (err) {
                    if (err.message === "AbortError") {
                        const abortSecs = (performance.now() - genStart) / 1000;
                        if (liveStatEl) liveStatEl.textContent = `${genTokens} tok · ${abortSecs > 0 ? (genTokens / abortSecs).toFixed(1) : "0.0"} tok/s (stopped)`;
                        wllamaLog("warn", `Generation aborted after ${genTokens} tokens`);
                        onDone(0, genTokens);
                    } else {
                        wllamaLog("error", "Generation failed:", err.message || err);
                        onError(err);
                    }
                }
                return;
            }
            // @wllama:end
            let promptTokens = 0;
            let completionTokens = 0;
            let chatUrl = API_URL.trim().replace(/\/+$/, "");
            if (!chatUrl.endsWith("/chat/completions")) {
                chatUrl = chatUrl + "/chat/completions";
            }
            
            try {
                const response = await fetch(chatUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + API_KEY },
                    body: JSON.stringify(payload),
                    signal: signal
                });

                if (!response.ok) {
                    let detail = response.statusText || "Unknown Error";
                    try { 
                        const errBody = await response.json(); 
                        detail = errBody.error?.message || detail; 
                    } catch (e) {}
                    throw new Error(`Server Error ${response.status}: ${detail}`);
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder("utf-8");
                let buffer = "";

                const processLine = (line) => {
                    if (line.trim() === "" || !line.startsWith("data: ")) return;
                    const dataStr = line.substring(6).trim();
                    if (dataStr === "[DONE]") return;

                    try {
                        const data = JSON.parse(dataStr);
                        const delta = data.choices && data.choices[0] && data.choices[0].delta;

                        const reasoningChunk = delta && (delta.reasoning_content || delta.reasoning || delta.thinking || "");
                        const contentChunk = delta && delta.content;

                        if (data.usage) {
                            promptTokens = data.usage.prompt_tokens || promptTokens;
                            completionTokens = data.usage.completion_tokens || completionTokens;
                        }

                        if (reasoningChunk || contentChunk) {
                            onChunk(reasoningChunk || "", contentChunk || "", promptTokens, completionTokens);
                        }
                    } catch (e) { console.error("Stream parse error:", e, "Line:", line); }
                };

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (const line of lines) processLine(line);
                }
                if (buffer.trim()) processLine(buffer);
                
                onDone(promptTokens, completionTokens);
            } catch (error) {
                onError(error);
            }
        }

        // ========== State ==========
        let messages = [{"role": "system", "content": SYSTEM_PROMPT}];
        let isWaiting = false;

        // ========== Main Submit Handler ==========
        chatForm.addEventListener("submit", async function(e) {
            e.preventDefault();
            if (isWaiting) return; 
            
            const text = inputField.value.trim();
            const isRegenerate = e.detail && e.detail.regenerate;
            
            const contextPane = document.getElementById("context-pane");
            const contextInput = document.getElementById("context-input");
            const isPaneVisible = contextPane && contextPane.style.display !== "none";
            const contextText = isPaneVisible && contextInput ? contextInput.value.trim() : "";
            const hasFiles = isPaneVisible && typeof attachedFiles !== "undefined" && attachedFiles.length > 0;

            if (!isRegenerate) {
                if (!text && !contextText && !hasFiles) return;

                const emptyState = document.getElementById("emptyState");
                if (emptyState) emptyState.remove();

                const textFiles = hasFiles ? attachedFiles.filter(f => f.kind !== "image") : [];
                const imageFiles = hasFiles ? attachedFiles.filter(f => f.kind === "image") : [];

                let payloadText = text;
                let contextBlocks = [];

                if (contextText) {
                    contextBlocks.push(`<context>\n${contextText}\n</context>`);
                }
                textFiles.forEach(f => {
                    contextBlocks.push(`<file name="${escapeHtml(f.name)}">\n${f.content}\n</file>`);
                });
                if (contextBlocks.length > 0) {
                    payloadText = contextBlocks.join("\n\n") + "\n\n" + text;
                }

                // When images are attached, send OpenAI multimodal content-array; otherwise
                // keep the plain-string form for maximum backend compatibility.
                if (imageFiles.length > 0) {
                    const parts = [{ type: "text", text: payloadText }];
                    imageFiles.forEach(f => {
                        parts.push({ type: "image_url", image_url: { url: f.dataUrl } });
                    });
                    messages.push({ "role": "user", "content": parts });
                } else {
                    messages.push({ "role": "user", "content": payloadText });
                }
                userScrolledUp = false; // Force scroll to bottom for new message

                const safeText = escapeHtml(text).replace(/\n/g, '<br>');
                let uiText = safeText;

                if (contextText || textFiles.length > 0) {
                    let combinedSafeContext = "";
                    if (contextText) {
                        combinedSafeContext += escapeHtml(contextText) + "\n\n";
                    }
                    textFiles.forEach(f => {
                        combinedSafeContext += `--- ${escapeHtml(f.name)} ---\n` + escapeHtml(f.content) + "\n\n";
                    });
                    uiText = `<details class="attached-context" style="margin-bottom: 12px; background: rgba(0,0,0,0.03); border-radius: 8px; padding: 10px; border: 1px solid rgba(0,0,0,0.05);"><summary style="cursor: pointer; font-weight: 600; color: #6b7280; font-size: 0.85rem; user-select: none;">📎 Attached Context</summary><pre style="white-space: pre-wrap; font-size: 0.85em; margin-top: 8px; color: #4b5563; font-family: inherit; overflow-x: auto;">${combinedSafeContext.trim()}</pre></details>` + uiText;
                }
                if (imageFiles.length > 0) {
                    // src is a locally-read/re-encoded data URL; alt is escaped filename.
                    const imgHtml = imageFiles.map(f =>
                        `<img class="attached-image-preview" src="${f.dataUrl}" alt="${escapeHtml(f.name)}">`
                    ).join("");
                    uiText = `<div class="attached-images">${imgHtml}</div>` + uiText;
                }

                uiText = DOMPurify.sanitize(uiText);
                appendMessage("You", uiText, "user", "🧑‍💻", true, {
                    text: text,
                    contextText: contextText,
                    files: typeof attachedFiles !== "undefined" ? attachedFiles.map(f => (
                        f.kind === "image"
                            ? { name: f.name, kind: "image", dataUrl: f.dataUrl }
                            : { name: f.name, kind: "text", content: f.content }
                    )) : []
                });
            }
            
            // UI update
            if (!isRegenerate) {
                inputField.value = "";
                inputField.style.height = "auto";
                if (typeof contextPane !== "undefined" && contextPane) {
                    contextPane.style.display = "none";
                }
                if (typeof contextInput !== "undefined" && contextInput) {
                    contextInput.value = "";
                    contextInput.style.height = "auto";
                }
                if (typeof attachContextBtn !== "undefined" && attachContextBtn) {
                    attachContextBtn.style.color = "#6b7280";
                }
                if (typeof attachedFiles !== "undefined") {
                    attachedFiles = [];
                    if (typeof renderChips === "function") renderChips();
                }
            }
            sendBtn.style.display = "none";
            stopBtn.style.display = "flex";
            inputField.disabled = true;
            isWaiting = true;
            
            abortController = new AbortController();

            const responseContainerId = appendMessage("AI", "", "ai", "✨");
            const responseContainer = document.getElementById(responseContainerId);
            
            // Prepare containers for reasoning and text
            responseContainer.innerHTML = `<div class="ai-response-body"></div>`;
            
            let ctx = {
                aiReasoning: "",
                fullRawText: "",
                startTime: Date.now(),
                responseContainer: responseContainer.querySelector('.ai-response-body')
            };
            
            let promptTokens = 0;
            let completionTokens = 0;
            
            // Throttled render function (avoids re-parsing markdown 50x/sec)
            const throttledRender = createThrottle(CONSTANTS.THROTTLE_MS);

            // Reset stats for new request
            updateGlobalStats("...", "...", "...", "0.0");

            document.getElementById('chatForm').classList.add('is-generating');
            responseContainer.classList.add('cursor');

            const chatPayload = {
                model: MODEL_NAME,
                messages: messages.filter(m => !m.isSummary),
                temperature: TEMPERATURE,
                stream: true,
                stream_options: { include_usage: true }
            };
            // Only send advanced params when set / non-default, for maximal backend compatibility.
            if (MAX_TOKENS != null) chatPayload.max_tokens = MAX_TOKENS;
            if (TOP_P !== 1) chatPayload.top_p = TOP_P;
            if (PRESENCE_PENALTY !== 0) chatPayload.presence_penalty = PRESENCE_PENALTY;
            if (FREQUENCY_PENALTY !== 0) chatPayload.frequency_penalty = FREQUENCY_PENALTY;
            if (SEED != null) chatPayload.seed = SEED;

            await fetchAndStreamChat(chatPayload, abortController.signal, {
                onChunk: (reasoningChunk, contentChunk, pt, ct) => {
                    if (reasoningChunk) ctx.aiReasoning += reasoningChunk;
                    if (contentChunk) ctx.fullRawText += contentChunk;
                    promptTokens = pt;
                    completionTokens = ct;
                    throttledRender(() => {
                        updateMessageUI(ctx, false);
                        let currentDuration = (Date.now() - ctx.startTime) / 1000;
                        let estTokens = Math.ceil((ctx.aiReasoning.length + ctx.fullRawText.length) / 4);
                        let currentTps = currentDuration > 0.2 ? (estTokens / currentDuration).toFixed(1) : "0.0";
                        updateGlobalStats(promptTokens || "...", estTokens, currentTps, currentDuration.toFixed(1), true);
                    });
                },
                onDone: (pt, ct) => {
                    promptTokens = pt;
                    completionTokens = ct;
                    updateMessageUI(ctx, true);
                    let finalHistoryContent = buildFinalHistory(ctx.fullRawText, ctx.aiReasoning);
                    messages.push({"role": "assistant", "content": finalHistoryContent});
                    finishGeneration();
                },
                onError: (error) => {
                    if (error.name === 'AbortError') {
                        updateMessageUI(ctx, true);
                        let finalHistoryContent = buildFinalHistory(ctx.fullRawText, ctx.aiReasoning);
                        messages.push({"role": "assistant", "content": finalHistoryContent});
                    } else {
                        const errMsg = error.message || "Unknown Error";
                        responseContainer.insertAdjacentHTML('beforeend', `<br><br><span style='color:#ef4444; font-weight:500;'>❌ ${DOMPurify.sanitize(errMsg)}</span><br><span style='color:#9ca3af; font-size:0.9rem;'>Make sure your local server is running and CORS is enabled.</span>`);
                    }
                    finishGeneration();
                }
            });

            function finishGeneration() {
                throttledRender.cancel();
                document.getElementById('chatForm').classList.remove('is-generating');
                responseContainer.classList.remove('cursor');
                sendBtn.style.display = "flex";
                stopBtn.style.display = "none";
                inputField.disabled = false;
                isWaiting = false;
                inputField.focus(); 
                
                let endTime = Date.now();
                let durationSec = (endTime - ctx.startTime) / 1000;
                
                if (completionTokens === 0 && messages.length > 0 && messages[messages.length-1].role === "assistant") {
                    completionTokens = Math.ceil(messages[messages.length-1].content.length / 4);
                }
                if (promptTokens === 0) {
                    const promptMsgs = messages.length > 0 && messages[messages.length - 1].role === "assistant" ? messages.slice(0, -1) : messages;
                    // content may be a multimodal array; estimate from text parts only.
                    let promptStr = promptMsgs.map(m => Array.isArray(m.content)
                        ? m.content.filter(p => p.type === "text").map(p => p.text).join(" ")
                        : m.content).join(" ");
                    promptTokens = Math.ceil(promptStr.length / 4);
                }
                
                let tps = completionTokens > 0 ? (completionTokens / durationSec).toFixed(1) : "0.0";
                updateGlobalStats(promptTokens, completionTokens, tps, durationSec.toFixed(1));
                
                if (!userScrolledUp) {
                    chatbox.scrollTop = chatbox.scrollHeight; 
                }
            }
        });

        // ========== Append Message ==========
        function appendMessage(sender, text, cssClass, emoji, isRawHtml = false, rawData = text) {
            const wrapper = document.createElement("div");
            wrapper.className = `msg-wrapper ${cssClass}`;
            
            const contentId = "content-" + Math.random().toString(36).substring(2, 10);
           
            const avatarDiv = document.createElement("div");
            avatarDiv.className = "avatar";
            avatarDiv.textContent = emoji;
            
            const contentContainer = document.createElement("div");
            contentContainer.className = "msg-content-container";
            
            const contentDiv = document.createElement("div");
            contentDiv.className = "msg-content";
            contentDiv.id = contentId;
            if (cssClass === "user") {
                if (isRawHtml) {
                    contentDiv.innerHTML = text;
                } else {
                    contentDiv.textContent = text; // Safe: plain text for user messages
                }
            } else {
                contentDiv.innerHTML = DOMPurify.sanitize(text); // AI messages may contain HTML
                renderMermaidBlocks(contentDiv);
            }
            
            const timeDiv = document.createElement("div");
            timeDiv.className = "msg-timestamp";
            const now = new Date();
            timeDiv.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            
            const actionsDiv = document.createElement("div");
            actionsDiv.className = "msg-actions";
            if (cssClass === "user") {
                const editBtn = document.createElement("button");
                editBtn.className = "action-btn";
                editBtn.innerHTML = "✏️ Edit";
                editBtn.addEventListener("click", () => {
                    if (isWaiting) return;
                    
                    if (rawData && typeof rawData === 'object') {
                        inputField.value = rawData.text || "";
                        if (rawData.contextText || (rawData.files && rawData.files.length > 0)) {
                            const contextPane = document.getElementById("context-pane");
                            const contextInput = document.getElementById("context-input");
                            const attachBtn = document.getElementById("attach-context-btn");
                            
                            if (contextPane) {
                                contextPane.style.display = "flex";
                                if (attachBtn) attachBtn.style.color = "var(--primary)";
                                if (contextInput) contextInput.value = rawData.contextText || "";
                            }
                            if (rawData.files && rawData.files.length > 0) {
                                attachedFiles = rawData.files.map(f => (
                                    f.kind === "image"
                                        ? { name: f.name, kind: "image", dataUrl: f.dataUrl }
                                        : { name: f.name, kind: "text", content: f.content }
                                ));
                                if (typeof renderChips === "function") renderChips();
                            }
                        }
                    } else {
                        inputField.value = typeof rawData === 'string' ? rawData : text;
                    }
                    
                    inputField.focus();
                    inputField.dispatchEvent(new Event('input'));
                    
                    let sibling = wrapper.nextElementSibling;
                    while (sibling) {
                        let next = sibling.nextElementSibling;
                        sibling.remove();
                        sibling = next;
                    }
                    wrapper.remove();
                    
                    const remainingWrappers = document.querySelectorAll(".msg-wrapper:not(.summary)");
                    messages = messages.slice(0, remainingWrappers.length + 1);
                });
                actionsDiv.appendChild(editBtn);
            } else if (cssClass === "ai") {
                const regenBtn = document.createElement("button");
                regenBtn.className = "action-btn";
                regenBtn.innerHTML = "🔄 Regenerate";
                regenBtn.addEventListener("click", () => {
                    if (isWaiting) return;
                    const aiWrappers = document.querySelectorAll(".msg-wrapper.ai");
                    if (aiWrappers.length > 0 && aiWrappers[aiWrappers.length - 1] === wrapper) {
                        wrapper.remove();
                        messages.pop(); // Remove the last AI message
                        chatForm.dispatchEvent(new CustomEvent("submit", { cancelable: true, detail: { regenerate: true } }));
                    } else {
                        showToast("⚠️ Can only regenerate the latest response.");
                    }
                });
                actionsDiv.appendChild(regenBtn);
            }
            
            contentContainer.appendChild(contentDiv);
            contentContainer.appendChild(actionsDiv);
            contentContainer.appendChild(timeDiv);
            wrapper.appendChild(avatarDiv);
            wrapper.appendChild(contentContainer);
            
            chatbox.appendChild(wrapper);
            if (!userScrolledUp) {
                chatbox.scrollTop = chatbox.scrollHeight;
            }
            return contentId;
        }
        // ========== Theme Toggle ==========
        const themeToggleBtn = document.getElementById("themeToggleBtn");
        let isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        
        function applyTheme() {
            if (isDarkMode) {
                document.documentElement.setAttribute("data-theme", "dark");
                themeToggleBtn.textContent = "🌞";
            } else {
                document.documentElement.removeAttribute("data-theme");
                themeToggleBtn.textContent = "🌙";
            }
        }
        
        // Initial application
        applyTheme();
        
        // Listen for OS changes
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', event => {
            isDarkMode = event.matches;
            applyTheme();
        });
        
        // Manual toggle
        if (themeToggleBtn) {
            themeToggleBtn.addEventListener("click", () => {
                isDarkMode = !isDarkMode;
                applyTheme();
            });
        }

        // ========== URL-Fragment Configuration ==========
        // A link can pre-wire the setup via hash params: #api=…&model=…&key=…&persona=…
        // (plus #gguf=… in the wllama build). The fragment never leaves the browser —
        // it isn't sent in HTTP requests — so this stays within the ephemerality rule:
        // the URL *is* the config, nothing is stored, and nothing is written back.
        // Applied once at startup; everything set here is announced via toast so a
        // shared link can't reconfigure the app invisibly. Free-text system prompts
        // are deliberately not supported (a link could smuggle a malicious prompt).
        function applyHashConfig() {
            if (location.hash.length < 2) return;
            const params = new URLSearchParams(location.hash.slice(1));
            const applied = [];

            const api = (params.get("api") || "").trim();
            if (api) {
                API_URL = api;
                let origin = api;
                // Opaque origins (e.g. protocol-less input) stringify to "null" — show the raw value instead.
                try { origin = new URL(api).origin; } catch { /* show as-is */ }
                if (origin === "null") origin = api;
                applied.push(`server ${origin}`);
            }
            const model = (params.get("model") || "").trim();
            if (model) {
                MODEL_NAME = model;
                applied.push(`model ${model}`);
            }
            const key = (params.get("key") || "").trim();
            if (key) {
                API_KEY = key;
                applied.push("API key (note: it stays in your browser history)");
            }
            const persona = (params.get("persona") || "").trim();
            if (persona && PERSONAS[persona]) {
                switchPersona(persona);
                applied.push(`persona ${PERSONAS[persona].label}`);
            }

            if (applied.length > 0) {
                updateOverlay();
                updateMainCloudWarning();
                showToast(`🔗 Applied from URL: ${applied.join(", ")}`);
            }
            // typeof-guard keeps this valid in the builds where the wllama block is stripped.
            if (typeof handleWllamaHashParams === "function") handleWllamaHashParams(params);
        }
        applyHashConfig();
