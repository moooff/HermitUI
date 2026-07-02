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
                    return `<pre><code class="hljs language-${validLanguage}">${highlighted}</code></pre>`;
                }
            }
        });

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
            document.getElementById("settingSystem").value = SYSTEM_PROMPT;
            updateVisionBadge();
            settingsModal.classList.add("active");
        });
        document.getElementById("settingsCancel").addEventListener("click", () => {
            settingsModal.classList.remove("active");
        });
        settingsModal.addEventListener("click", (e) => {
            if (e.target === settingsModal) settingsModal.classList.remove("active");
        });
        document.getElementById("settingsSave").addEventListener("click", () => {
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
            settingsModal.classList.remove("active");
        });

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

        // ========== Stream Fetch Helper ==========
        async function fetchAndStreamChat(payload, signal, callbacks) {
            const { onChunk, onDone, onError } = callbacks;
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

            await fetchAndStreamChat({
                model: MODEL_NAME,
                messages: messages.filter(m => !m.isSummary),
                temperature: TEMPERATURE,
                stream: true,
                stream_options: { include_usage: true }
            }, abortController.signal, {
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
