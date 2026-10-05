# Phase 3.5 study — which pure-Python libraries to bundle

*2026-10-05/06. Pyodide 0.29.5, Qwen3.8-27B (IQ4_XS, llama.cpp, reasoning effort Low).
Decided before the study: the libraries are **bundled** in the HTML (ROADMAP, Phase 3.5).
This study decides **which**; the owner makes the final pick.*

## The question

The libraries most people and models reach for to write Office files, PDFs and similar
formats are pure-Python. Pyodide leaves those out of its distribution and expects
`micropip` to fetch them from PyPI, which agent code can't do (no network). Each library
bundled costs file size. Which ones earn their place?

## Method

Three parts, with scripts in `spike/` (results in `spike/out/`, gitignored):

1. **Cost and fit** (`spike/library_study.py`). 33 candidates across 13 task areas. For
   each: the latest version on PyPI, whether it ships a pure-Python wheel, its size plus
   the size of any dependency Pyodide lacks (dependencies Pyodide has cost nothing), its
   license, and last month's downloads (pypistats.org).
2. **Works in Pyodide** (`spike/library_smoke.py`). Each candidate's wheels are unpacked
   into site-packages in the app's own interpreter (what bundling would do), and one
   small real task runs through the app's `runInWorker`: an Excel round trip, a Word
   table, a chart in a slide, a PDF with a table, and so on.
3. **What the model reaches for** (`spike/library_preference.py`). Qwen3.8 does 18
   everyday format tasks that name no library, in the last committed build (v0.2.0,
   whose system prompt suggests no library), under autopilot. Every import it attempts
   is recorded, from step code and the `.py` files it writes, along with the modules it
   found missing, its steps and its time.

## 1. Cost and fit

Sizes include the dependencies Pyodide lacks; downloads are last month's, in millions.
HermitUI is AGPL-3.0, so every license here is compatible; the bundle has to carry each
license text.

| Area | Library | Size | Extra deps | Downloads | License |
|---|---|---:|---|---:|---|
| Excel | **openpyxl** 3.1.5 | 263 KB | et-xmlfile | 278.5 | MIT |
| Excel | **XlsxWriter** 3.2.9 | 171 KB | – | 93.2 | BSD-2 |
| Word | **python-docx** 1.2.0 | 247 KB | – | 93.8 | MIT |
| Word | docx2txt 0.9 | 4 KB | – | 3.8 | MIT |
| Word | mammoth 1.13.0 | 58 KB | cobble | 15.8 | BSD-2 |
| Word | docxtpl 0.20.2 | 265 KB | python-docx | 3.4 | LGPL-2.1 |
| PowerPoint | **python-pptx** 1.0.2 | 633 KB | XlsxWriter (171 KB of it) | 58.7 | MIT |
| OpenDocument | odfpy 1.4.1 | 700 KB | defusedxml *(undeclared)* | 5.1 | Apache-2.0 |
| PDF create | fpdf2 2.8.9 | 358 KB | defusedxml | 16.3 | LGPL-3.0 |
| PDF create | reportlab 5.0.1 | 1,911 KB | – | 65.4 | BSD |
| PDF read/edit | pypdf 6.19.0 | 386 KB | – | 123.7 | BSD-3 |
| PDF read/edit | pdfminer.six | 6,438 KB | – | 52.4 | MIT |
| Markdown/HTML | **Markdown** 3.11 | 109 KB | – | 89.2 | BSD-3 |
| Markdown/HTML | markdown-it-py 4.2.0 | 99 KB | mdurl | 440.6¹ | MIT |
| Markdown/HTML | mistune 3.3.4 | 65 KB | – | 59.8 | BSD-3 |
| Markdown/HTML | html2text | 34 KB | – | 12.2 | GPL-3.0+ |
| Markdown/HTML | markdownify 1.2.3 | 15 KB | – | 53.8 | MIT |
| Text tables | tabulate 0.10.0 | 39 KB | – | 149.9 | MIT |
| Charts | seaborn 0.13.2 | 288 KB | – | 26.2 | BSD |
| Charts | plotly 7.1.0 | 9,465 KB | – | 48.0 | MIT |
| Data formats | xmltodict 1.0.4 | 13 KB | – | 91.3 | MIT |
| Data formats | jsonschema | *already in Pyodide* | | | |
| Data formats | icalendar 7.3.0 | 530 KB | – | 7.4 | BSD-2 |
| Data formats | feedparser 6.0.14 | 90 KB | feedparser-sgmllib | 16.7 | BSD-2 |
| Text | Unidecode 1.4.0 | 230 KB | – | 25.2 | GPL-2.0+ |
| Text | python-slugify 9.1.2 | 92 KB | text-unidecode | 62.9 | MIT |
| Text | chardet 7.6.0 | 664 KB | – | 157.0¹ | 0BSD |
| Text | humanize 4.16.0 | 134 KB | – | 45.6 | MIT |
| Text | num2words 0.5.14 | 185 KB | docopt (source only) | 7.6 | LGPL |
| QR / barcodes | **qrcode** 8.2 | 45 KB | – | 27.7 | BSD |
| QR / barcodes | segno 1.6.6 | 75 KB | – | 5.2 | BSD |
| QR / barcodes | python-barcode 0.16.1 | 223 KB | – | 2.8 | MIT |
| Test data | Faker 40.40.0 | 2,018 KB | – | 63.2 | MIT |

¹ Inflated by being a dependency of very common packages (markdown-it-py of `rich`,
chardet of `requests`). Downloads show reach, not what people pick for a task.

odfpy and docopt publish no wheel, only a source archive. Both are pure Python, so a
wheel can be built from them at build time.

## 2. Works in Pyodide: 32 of 32

Every candidate ran its task in the app's interpreter, mostly in under a second once
unpacked (seaborn 4.6 s and pypdf/pdfminer about 3.5 s, mostly loading numpy, pandas and
matplotlib or pymupdf). Seven needed something their PyPI metadata doesn't declare.
**Bundling has to carry this**, because the harness only loads the Pyodide packages a
step's own code imports, and these are imported inside the library:

| Library | Needs, undeclared or only as an optional extra |
|---|---|
| python-docx, python-pptx, docxtpl | Pyodide's `lxml` and `typing_extensions` (declared, but imported inside the library, so the harness must load them with it) |
| python-pptx | also Pyodide's `Pillow` (declared; same reason) |
| fpdf2 | Pyodide's `ssl` module, or its `urllib` import fails |
| qrcode, python-barcode | Pyodide's `Pillow`, for PNG output (an optional extra) |
| plotly | `numpy` and `pandas` for `plotly.express` (an optional extra) |
| odfpy | `defusedxml` (its source archive declares nothing) |

So each bundled library needs a small manifest: its wheels plus the Pyodide packages to
load with it.

## 3. What the model reaches for

One run per task (the QR, OpenDocument and XML tasks a second time, after a fix to the
study script). "Tried" lists the non-stdlib imports in the order they appeared; "missing"
lists what failed to import.

| Task | Tried | Missing | Steps | Time | How it ended |
|---|---|---|---:|---:|---|
| Excel (.xlsx, sheet per region) | openpyxl, pandas, xlsxwriter | openpyxl | 10 | 58 s | finished without an Excel library (none exists here) |
| Word report (.docx) | docx (python-docx) | docx | 13 | 85 s | wrote the docx XML by hand |
| PowerPoint deck with a chart | – | – | 8 | 239 s | wrote the pptx XML by hand |
| PDF invoice | matplotlib | – | 3 | 21 s | matplotlib |
| PDF read | fitz (pymupdf) | – | 2 | 6 s | pymupdf |
| PDF merge | fitz (pymupdf) | – | 2 | 8 s | pymupdf |
| Markdown → HTML | – | – | 9 | 42 s | wrote its own Markdown parser |
| HTML → Markdown | – | – | 3 | 4 s | by hand |
| Plain-text table | – | – | 4 | 9 s | by hand |
| QR code PNG | qrcode, cv2, numpy | qrcode | 11 | 349 s | OpenCV's QR encoder (in Pyodide); the first run never finished in 300 s |
| OpenDocument (.ods) | – | – | 6 | 28 s | wrote the ods XML by hand |
| Box plot with points | matplotlib, numpy, pandas | – | 4 | 14 s | matplotlib |
| Calendar invite (.ics) | – | – | 3 | 20 s | by hand (a short text format) |
| ASCII slugs | – | – | 3 | 8 s | by hand (`unicodedata`) |
| Fake customer data | – | – | 5 | 45 s | by hand (lists of names) |
| Encoding detection | – | – | 3 | 7 s | by hand (tried encodings) |
| XML → JSON | – | – | 3 | 7 s | by hand (`xml.etree`) |
| Amount in words (EN, DE) | – | – | 4 | 12 s | by hand |

What this shows:
- **Where the model wants a library, it names one at once:** openpyxl, then xlsxwriter
  for Excel; python-docx for Word; qrcode for QR codes. Missing, they cost 10–13 steps,
  and up to 6 minutes for QR.
- **Where it doesn't try any, the result can still be slow:** a PowerPoint deck built
  from raw XML took 4 minutes, and a hand-written Markdown parser took 9 steps.
- **PDF needs nothing new:** with no hint at all, the model chose matplotlib and pymupdf,
  which Pyodide has, and finished in 2–3 steps. fpdf2, reportlab, pypdf and pdfminer.six
  would add 0.4–6 MB for no observed gain.
- **Short text formats are fine by hand:** ics, slugs, encodings, XML → JSON, plain-text
  tables and number words took 3–5 steps.

**Limits.** One model and one run per task. "Done" means the agent finished, not that
the file is right: hand-built `.docx`, `.pptx` and `.ods` files and German number words
weren't checked for validity or correctness. That is where hand-building most likely
fails quietly. The success-measurement tasks in Phase 3.5 should check the files with
the bundled libraries.

## Recommendation (the owner picks)

**Tier 1, bundle:** each was the model's own first choice, or the format took 4+ minutes
by hand.

| Library | Why | Size |
|---|---|---:|
| openpyxl (+ et-xmlfile) | the model's first pick for Excel; also what `pandas.read_excel` / `to_excel` use | 263 KB |
| XlsxWriter | the model's second pick; python-pptx needs it for charts | 171 KB |
| python-docx | the model's pick for Word | 247 KB |
| python-pptx | 4 minutes by hand without it | 461 KB |
| Markdown | 9 steps for a hand-written parser without it | 109 KB |
| qrcode | the model's pick; up to 6 minutes without it | 45 KB |
| **Total** | about 1.8 MB once base64-inlined (the file grows from 9.0 to about 10.8 MB) | **1.33 MB** |

With the Pyodide packages they need loaded alongside: lxml and typing_extensions
(python-docx, python-pptx), Pillow (python-pptx, qrcode).

**Tier 2, cheap, optional:** tabulate (39 KB), xmltodict (13 KB), markdownify (15 KB),
seaborn (288 KB). The model managed these tasks by hand, but they're small and common, and
seaborn is what many users expect for statistical charts. About 0.35 MB in all.

**Not recommended:** the PDF libraries (fpdf2, reportlab, pypdf, pdfminer.six; pymupdf
and matplotlib already cover it), plotly (9.5 MB), Faker (2 MB), odfpy (0.7 MB for a
rare format), icalendar, chardet, Unidecode / python-slugify, num2words, humanize,
feedparser, segno, python-barcode, and the docx extras (docx2txt, mammoth, docxtpl).
Revisit any of them if users ask for them.

**System prompt (Phase 3.5):** name the bundled libraries for their formats (Excel →
openpyxl or XlsxWriter, also `pandas.to_excel`; Word → python-docx; PowerPoint →
python-pptx; Markdown → `markdown`; QR → qrcode), keep pymupdf and matplotlib for PDF,
and keep the rule not to assemble formats by hand.
