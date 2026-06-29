<div align="center">
  <img width="500" alt="hermitui-logo" src="https://github.com/user-attachments/assets/f501dda0-d187-4318-aaf8-b10ac085788b" />
  <p><i>A lightweight, modern, and ephemeral single-page web interface for local AI models.</i></p>
  <p>
    <a href="https://moooff.github.io/HermitUI"><b>🌐 Online Demo</b></a> •
    <a href="#-ideal-use-cases">Use Cases</a> •
    <a href="#-features">Features</a> •
    <a href="#-quick-start">Quick Start</a> •
    <a href="#-troubleshooting-cors">Troubleshooting</a> •
    <a href="#-built-with">Built With</a> •
    <a href="#-architecture--philosophy">Architecture</a>
  </p>
</div>

![HermitUI Screenshot](screenshot.png)

> ### 🚀 [Try the Live Online Demo](https://moooff.github.io/HermitUI)
> *Works entirely in your browser. Just connect it to your local AI server!*

HermitUI is a highly responsive web interface tailored for interacting with local AI models. Its source code is built **entirely within a single `src/hermit-ui.src.html` file** using vanilla HTML, CSS, and JavaScript. 

No build steps, no backend, and no installation required—just open the file in your browser and start chatting!

## 🎯 Ideal Use Cases

*   **Heavily Regulated Environments:** Perfect for enterprise or government networks where software installation is restricted, but a secure local or remote inference endpoint is accessible.
*   **Air-Gapped Systems:** Can be easily distributed via USB and run on disconnected systems that only have access to a local network LLM server.
*   **Ephemeral Kiosks & Shared Terminals:** Ensures privacy by not saving any chat history, making it safe for public or shared workstations, especially in desk-sharing environments.

## ✨ Features

*   **📦 Zero-Dependency Setup:** The default `hermit-ui.html` file has all external libraries (Marked.js, DOMPurify, Highlight.js) bundled directly into it. No installation or build steps required for the user. (A developer version using CDNs is available in `src/hermit-ui.src.html`).
*   **🔒 Privacy First & Ephemeral:** By design, there is no local saving (`localStorage`, `IndexedDB`, or cookies) and no conversation history stored across sessions. Your data stays completely ephemeral.
*   **🧠 Thinking Model Support:** Built-in parser beautifully formats `<think>`, `<thought>`, and `<reasoning>` tags natively streamed by advanced reasoning models.
*   **🎨 Modern UI/UX:** Clean, responsive design with smooth micro-animations, comprehensive CSS variables for easy theming, syntax highlighting, and a premium glassmorphism feel.
*   **⚡ Real-Time Streaming:** Watch responses generate in real-time with an experience comparable to ChatGPT.
*   **📊 Live Performance Stats:** Built-in dashboard to monitor Prompt Tokens, Completion Tokens, Generation Speed (Tokens/Second), and Total Duration.
*   **📝 Markdown & Code Support:** Renders rich Markdown and provides one-click "Copy" buttons for code blocks.
*   **💾 Chat Export:** Easily download your entire conversation history as a formatted Markdown file for safekeeping.
*   **⚙️ Customizable Settings:** Quickly adjust the API URL, Model Name, and System Prompt via the on-page settings overlay.

## 🚀 Quick Start

1.  **Start your local AI server:**
    Ensure you have a local AI server running that provides an OpenAI-compatible API endpoint.
    *   *Examples:* [LM Studio](https://lmstudio.ai/), [Ollama](https://ollama.com/) (with OpenAI compatibility), or [vLLM](https://github.com/vllm-project/vllm).
    *   *Default expected endpoint:* `http://localhost:1234/v1/chat/completions` (LM Studio default).
2.  **Open HermitUI:**
    Simply double-click the `hermit-ui.html` file to open it in any modern web browser.
3.  **Configure (if needed):**
    Click the **⚙️ Settings** button in the top right corner to update the API URL, the Model Name, or the default System Prompt to match your local setup.

## 💡 Setup Examples

Here are a few quick configuration examples based on popular local AI servers:

### Using LM Studio (Default)
1. Launch LM Studio and start the **Local Server**.
2. **API URL:** `http://localhost:1234/v1/chat/completions`
3. **Model Name:** Leave blank, or set to the specific model identifier you loaded.
4. *Tip:* Ensure CORS is enabled in the LM Studio settings.

### Using Ollama
1. Start your Ollama server from the terminal, making sure to enable CORS:
   ```bash
   OLLAMA_ORIGINS="*" ollama serve
   ```
2. **API URL:** `http://localhost:11434/v1/chat/completions`
3. **Model Name:** The name of the model you pulled (e.g., `llama3`, `mistral`, `deepseek-coder`).

### Using vLLM
1. Start your vLLM server with an OpenAI-compatible endpoint:
   ```bash
   python -m vllm.entrypoints.openai.api_server --model meta-llama/Llama-2-7b-chat-hf --cors-allowed-origins "*"
   ```
2. **API URL:** `http://localhost:8000/v1/chat/completions`
3. **Model Name:** The model name specified in your command (e.g., `meta-llama/Llama-2-7b-chat-hf`).

### Using Cloud Models (OpenRouter, OpenAI, Groq, etc.)
You are not limited to local models! HermitUI works perfectly with any cloud provider that offers an OpenAI-compatible API endpoint.
1. **API URL:** The provider's chat completions endpoint (e.g., `https://openrouter.ai/api/v1/chat/completions` or `https://api.openai.com/v1/chat/completions`).
2. **Model Name:** The specific model you want to use (e.g., `anthropic/claude-3.5-sonnet`, `gpt-4o`).
3. **API Key:** Enter your provider's API key in the settings menu.

## 🔧 Troubleshooting (CORS)

If HermitUI fails to connect to your local AI server (e.g., getting a "Network Error"), it is most likely due to **CORS (Cross-Origin Resource Sharing)** restrictions. Because HermitUI runs as a local file (`file://`), modern browsers will block its requests to `http://localhost` unless the server explicitly allows it.

**How to fix it:**
*   **LM Studio:** Go to the "Local Server" tab, look for the "CORS" toggle, and make sure it is turned **ON**.
*   **Ollama:** You must set the `OLLAMA_ORIGINS` environment variable before starting Ollama. For example: `OLLAMA_ORIGINS="*" ollama serve`.
*   **vLLM:** Start your server with the `--cors-allowed-origins` flag. For example: `--cors-allowed-origins "*"`.

## 🏗️ Architecture & Philosophy

HermitUI enforces strict architectural constraints to remain lightweight and accessible:
*   **Single File Constraint:** The final product must always be a single, standalone `.html` file. The `src/` directory acts only as a blueprint; even if CSS or JS are refactored into separate files for development, the resulting output in the `dist/` directory and the root `index.html` will always remain fully integrated single files.
*   **Online Version:** You can try the live version hosted on GitHub Pages: [https://moooff.github.io/HermitUI](https://moooff.github.io/HermitUI)
*   **Vanilla Only:** No React, Vue, Angular, or complex frontend frameworks. 
*   **No Build Tools:** No `package.json`, `npm`, Webpack, or Vite.
*   **No CSS Frameworks:** Pure Vanilla CSS, no Tailwind or Bootstrap.
*   **Security:** All rendered AI responses are rigorously sanitized using `DOMPurify` to prevent XSS attacks.

## 📦 Building & Development

By default, the `hermit-ui.html` file in the root is a completely offline, standalone version. Web fonts and images are base64-encoded, while external JS/CSS libraries are injected directly into the file. It is perfect for air-gapped environments.

If you wish to modify the source code, edit `src/hermit-ui.src.html` (which uses CDNs for external libraries) and then run the build script to regenerate the standalone root file:

```bash
python build.py
```

This updates the root `hermit-ui.html` file and creates alternative builds in the `dist/` directory.

## 🛠️ Built With

*   **Vanilla HTML5 / CSS3 / ES6 JavaScript**
*   [Marked.js](https://marked.js.org/) - For parsing Markdown
*   [DOMPurify](https://github.com/cure53/DOMPurify) - For sanitizing HTML and preventing XSS
*   [Highlight.js](https://highlightjs.org/) - For code syntax highlighting
*   [Google Fonts (Inter)](https://fonts.google.com/specimen/Inter) - For clean, modern typography

## 📄 License

This project is open-source and available under the terms of the included LICENSE file.
