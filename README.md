<img width="2816" height="1536" alt="hermitui-logo" src="https://github.com/user-attachments/assets/729ae07d-0caa-4be2-bb32-431a5f344afd" />
# HermitUI

HermitUI is a lightweight, modern, and highly responsive single-page web interface for interacting with local AI models. It is built entirely in a single `hermit-ui.html` file using vanilla HTML, CSS, and JavaScript. 

No build steps, no backend, and no installation required—just open the file in your browser and start chatting!

## ✨ Features

- **Zero-Dependency Setup:** Everything is bundled in a single HTML file (external libraries like Marked.js, DOMPurify, and Highlight.js are loaded via CDN).
- **Thinking Model Support:** Built-in parser to beautifully format `<think>`, `<thought>`, and `<reasoning>` tags natively streamed by advanced reasoning models.
- **Modern UI/UX:** Clean, responsive design with smooth animations, syntax highlighting, and a glassmorphism feel.
- **Real-Time Streaming:** Watch responses generate in real-time, just like ChatGPT.
- **Live Performance Stats:** Built-in dashboard to monitor Prompt Tokens, Completion Tokens, Generation Speed (Tokens/Second), and Total Duration.
- **Markdown & Code Support:** Renders rich Markdown and provides 1-click "Copy" buttons for code blocks.
- **Chat Export:** Easily download your entire conversation history as a formatted Markdown file.
- **Customizable Settings:** Quickly adjust the API URL, Model Name, and System Prompt via the on-page settings overlay.

## 🚀 Quick Start

1. **Start your local AI server:**
   Ensure you have a local AI server running that provides an OpenAI-compatible API endpoint. (e.g., [LM Studio](https://lmstudio.ai/), [Ollama](https://ollama.com/) (with OpenAI compat), or [text-generation-webui](https://github.com/oobabooga/text-generation-webui)).
   - *Default expected endpoint:* `http://localhost:1234/v1/chat/completions` (LM Studio default).

2. **Open HermitUI:**
   Simply double-click the `hermit-ui.html` file to open it in any modern web browser.

3. **Configure (if needed):**
   Click the **⚙️ Settings** button in the top right corner to update the API URL, the Model Name, or the default System Prompt.

## 🛠️ Built With

- Vanilla HTML5 / CSS3 / JavaScript
- [Marked.js](https://marked.js.org/) - For Markdown parsing
- [DOMPurify](https://github.com/cure53/DOMPurify) - For sanitizing HTML and preventing XSS
- [Highlight.js](https://highlightjs.org/) - For code syntax highlighting
- [Google Fonts (Inter)](https://fonts.google.com/specimen/Inter) - For clean typography

## 📄 License

This project is open-source and available under the terms of the included LICENSE file.
