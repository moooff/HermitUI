# Workspace Rules for HermitUI

Welcome to the `AGENTS.md` file! This file dictates the strict architectural constraints and workflow rules for HermitUI.

## 🏗️ Architecture & Frameworks
- **Single File Constraint:** The core application must remain entirely within `src/hermit-ui.src.html`. Do not split the code into separate `.js` or `.css` files unless explicitly modifying the `build.py` workflow.
- **No Build Tools:** Do NOT add `package.json`, `npm`, Webpack, Vite, or any other Node.js build tools. 
- **Vanilla Only:** Do NOT use React, Vue, Angular, or any frontend frameworks. Use modern Vanilla JavaScript (ES6+) only.
- **No CSS Frameworks:** Do NOT use TailwindCSS, Bootstrap, or any CSS preprocessors. Use Vanilla CSS.

## 🎨 Styling & UI/UX
- **Aesthetics:** Maintain the modern "glassmorphism" feel. Use smooth animations, CSS variables for theming, and the `Inter` font.
- **Responsiveness:** Ensure all CSS changes remain mobile-responsive by leveraging fluid design principles (like flexbox and max-width). Avoid explicit media queries to keep the CSS simple unless absolutely necessary.

## 🔒 Security & Data
- **Ephemeral State:** Do absolutely NOT implement `localStorage`, `IndexedDB`, or cookies for ANY reason (including settings, preferences, or conversation history). Privacy and strict ephemerality are core features.
- **Sanitization:** Any text returned by the AI that is rendered as HTML or Markdown MUST be sanitized using `DOMPurify.sanitize()` to prevent XSS attacks.

## 🤖 AI & API Integration
- **API Compatibility:** All network requests must strictly adhere to the OpenAI chat completions API schema. 
- **Thinking Tags:** Ensure any UI changes preserve the ability to parse and elegantly render `<think>`, `<thought>`, and `<reasoning>` tags.

## 🔄 Git & Versioning Workflow
- **Check Origin:** ALWAYS check origin for change or new Stuff before start of edit or task
- **Pre-Commit Review:** ALWAYS conduct a careful review of your changes before executing a `git commit` to ensure everything is correct, strictly adheres to the rules, and does not introduce any bugs or inconsistencies.
- **Build Before Commit:** ALWAYS run `python3 build.py` to regenerate the compiled files before executing a `git commit`.
- **Local Commits:** ALWAYS commit changes locally using `git commit` immediately after completing a task or edit. 
- **Remote Pushing:** Do NOT push commits to GitHub (or any remote repository) unless explicitly requested by the user.
- **Agent Rules:** The `.agents/` directory (including `AGENTS.md`) is for local configuration only. NEVER commit or push these files to the remote repository; ensure they remain in `.gitignore`.
- **Version Bumping:** Whenever a new version is tagged in git, automatically update the version number within the `src/hermit-ui.src.html` file to match.

## 📝 Safe Refactoring Workflow
- **Implementation Plans:** Because the application is a single large file (`src/hermit-ui.src.html`), ALWAYS create an Implementation Plan artifact (`implementation_plan.md`) before making any structural or major feature changes. 
- **Wait for Approval:** Request explicit user approval on the proposed plan before editing `src/hermit-ui.src.html`.
- **Walkthroughs:** After completing major changes, generate a Walkthrough artifact (`walkthrough.md`) summarizing the exact modifications made.
