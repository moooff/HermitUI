<div align="center">
  <img width="500" alt="hermitui-logo" src="https://github.com/user-attachments/assets/f501dda0-d187-4318-aaf8-b10ac085788b" />
  <h1>HermitUI</h1>
  <p><i>A lightweight, modern, and ephemeral single-page web interface for local AI models.</i></p>
  <p>
    <a href="#-ideal-use-cases">Use Cases</a> •
    <a href="#-features">Features</a> •
    <a href="#-quick-start">Quick Start</a> •
    <a href="#-built-with">Built With</a> •
    <a href="#-architecture--philosophy">Architecture</a>
  </p>
</div>

![HermitUI Screenshot](screenshot.png)

HermitUI is a highly responsive web interface tailored for interacting with local AI models. It is built **entirely within a single `hermit-ui.html` file** using vanilla HTML, CSS, and JavaScript. 

No build steps, no backend, and no installation required—just open the file in your browser and start chatting!

## 🎯 Ideal Use Cases

*   **Heavily Regulated Environments:** Perfect for enterprise or government networks where software installation is restricted, but a safe local or a safe remote inference endpoint is accessible.
*   **Air-Gapped Systems:** Can be easily distributed via USB and run on disconnected systems that only have access to a local network LLM server.
*   **Ephemeral Kiosks & Shared Terminals:** Ensures privacy by not saving any chat history, making it safe for public or shared workstations esp. while using Desk-Sharing.

## ✨ Features

*   **📦 Zero-Dependency Setup:** Everything is bundled in a single HTML file. External libraries (Marked.js, DOMPurify, Highlight.js) are loaded securely via CDN.
*   **🔒 Privacy First & Ephemeral:** By design, there is no local saving (`localStorage`, `IndexedDB`, or cookies) and no conversation history stored across sessions. Your data stays completely ephemeral.
*   **🧠 Thinking Model Support:** Built-in parser beautifully formats `<think>`, `<thought>`, and `<reasoning>` tags natively streamed by advanced reasoning models.
*   **🎨 Modern UI/UX:** Clean, responsive design with smooth micro-animations, comprehensive CSS variables for easy theming, syntax highlighting, and a premium glassmorphism feel.
*   **⚡ Real-Time Streaming:** Watch responses generate in real-time with an experience comparable to ChatGPT.
*   **📊 Live Performance Stats:** Built-in dashboard to monitor Prompt Tokens, Completion Tokens, Generation Speed (Tokens/Second), and Total Duration.
*   **📝 Markdown & Code Support:** Renders rich Markdown and provides one-click "Copy" buttons for code blocks.
*   **💾 Chat Export:** Easily download your entire conversation history as a formatted Markdown file for safekeeping.
*   **⚙️ Customizable Settings:** Quickly adjust the API URL, Model Name, and System Prompt via the on-page settings overlay.

## Screenshot

![HermitUI Screenshot](screenshot.png)

## 🚀 Quick Start

1.  **Start your local AI server:**
    Ensure you have a local AI server running that provides an OpenAI-compatible API endpoint.
    *   *Examples:* [LM Studio](https://lmstudio.ai/), [Ollama](https://ollama.com/) (with OpenAI compat) or vLLM
    *   *Default expected endpoint:* `http://localhost:1234/v1/chat/completions` (LM Studio default).
2.  **Open HermitUI:**
    Simply double-click the `hermit-ui.html` file to open it in any modern web browser.
3.  **Configure (if needed):**
    Click the **⚙️ Settings** button in the top right corner to update the API URL, the Model Name, or the default System Prompt to match your local setup.

## 🏗️ Architecture & Philosophy

HermitUI enforces strict architectural constraints to remain lightweight and accessible:
*   **Single File Constraint:** The entire application lives within `hermit-ui.html`.
*   **Vanilla Only:** No React, Vue, Angular, or complex frontend frameworks. 
*   **No Build Tools:** No `package.json`, `npm`, Webpack, or Vite.
*   **No CSS Frameworks:** Pure Vanilla CSS, no Tailwind or Bootstrap.
*   **Security:** All rendered AI responses are rigorously sanitized using `DOMPurify` to prevent XSS attacks.

## 🛠️ Built With

*   **Vanilla HTML5 / CSS3 / ES6 JavaScript**
*   [Marked.js](https://marked.js.org/) - For parsing Markdown
*   [DOMPurify](https://github.com/cure53/DOMPurify) - For sanitizing HTML and preventing XSS
*   [Highlight.js](https://highlightjs.org/) - For code syntax highlighting
*   [Google Fonts (Inter)](https://fonts.google.com/specimen/Inter) - For clean, modern typography

## 📄 License

This project is open-source and available under the terms of the included LICENSE file.
