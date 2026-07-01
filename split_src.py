import re

with open('src/hermit-ui.src.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Extract the main style block
style_match1 = re.search(r'<style>(.*?)</style>', content, re.DOTALL)
style1 = style_match1.group(1).strip() if style_match1 else ""

# Extract dark mode style block
style_match2 = re.search(r'<style id="dark-mode-styles">(.*?)</style>', content, re.DOTALL)
style2 = style_match2.group(1).strip() if style_match2 else ""

# Combine styles
full_style = style1 + "\n\n/* Dark Mode Styles */\n" + style2

# Extract script block
script_match = re.search(r'<script>(.*?)</script>', content, re.DOTALL)
full_script = script_match.group(1).strip() if script_match else ""

# Create index.html by replacing blocks
index_html = content
if style_match1:
    index_html = index_html.replace(style_match1.group(0), '<link rel="stylesheet" href="style.css">')
if style_match2:
    index_html = index_html.replace(style_match2.group(0), '')
if script_match:
    index_html = index_html.replace(script_match.group(0), '<script src="script.js"></script>')

# Remove any empty lines left by removing the dark mode style
index_html = re.sub(r'\n\s*\n\s*</head>', '\n</head>', index_html)

with open('src/style.css', 'w', encoding='utf-8') as f:
    f.write(full_style + "\n")

with open('src/script.js', 'w', encoding='utf-8') as f:
    f.write(full_script + "\n")

with open('src/index.html', 'w', encoding='utf-8') as f:
    f.write(index_html)

print("Split completed successfully.")
