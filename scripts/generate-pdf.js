import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { marked } from 'marked';
import katex from 'katex';

const mdPath = path.resolve('docs/dynasty-alpha-technical-report.md');
const htmlPath = path.resolve('docs/dynasty-alpha-technical-report.html');
const pdfPath = path.resolve('docs/dynasty-alpha-technical-report.pdf');

console.log('Reading markdown from:', mdPath);
let rawMd = fs.readFileSync(mdPath, 'utf8');

// 1. Separate literal USD currency signs from LaTeX math
// Currency amounts: $ followed by digits (e.g. $575.13, $0.55, $16,000)
// Replace with temporary token __USD_CURRENCY__
let processedMd = rawMd.replace(/\$(\d[\d,\.]*[kKMmB]?)(?!\w)/g, '&#36;$1');

// 2. Render Display Math ($$ ... $$)
processedMd = processedMd.replace(/\$\$([\s\S]+?)\$\$/g, (match, expr) => {
  try {
    const cleanExpr = expr.trim().replace(/&#36;/g, '\\$');
    return `<div class="math-display">${katex.renderToString(cleanExpr, { displayMode: true, throwOnError: false })}</div>`;
  } catch (e) {
    return match;
  }
});

// 3. Render Inline Math ($ ... $)
processedMd = processedMd.replace(/(^|[^\\])\$([^\$\n]+?)\$/g, (match, prefix, expr) => {
  try {
    const cleanExpr = expr.trim().replace(/&#36;/g, '\\$');
    return prefix + katex.renderToString(cleanExpr, { displayMode: false, throwOnError: false });
  } catch (e) {
    return match;
  }
});

// 4. Convert Mermaid diagrams to crisp inline SVG
const mermaidSvg = `
<div class="svg-diagram-wrapper">
  <svg viewBox="0 0 760 370" width="100%" height="370" xmlns="http://www.w3.org/2000/svg" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
    <defs>
      <linearGradient id="gradHeader" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#0f172a" />
        <stop offset="100%" stop-color="#1e293b" />
      </linearGradient>
      <linearGradient id="gradModule" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#f8fafc" />
        <stop offset="100%" stop-color="#f1f5f9" />
      </linearGradient>
      <linearGradient id="gradHighlight" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#eff6ff" />
        <stop offset="100%" stop-color="#dbeafe" />
      </linearGradient>
      <filter id="shadow" x="-5%" y="-5%" width="110%" height="110%">
        <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000000" flood-opacity="0.08" />
      </filter>
      <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 1 L 9 5 L 0 9 z" fill="#475569" />
      </marker>
    </defs>

    <!-- Block Observation Node -->
    <rect x="240" y="10" width="280" height="38" rx="6" fill="#0f172a" filter="url(#shadow)" />
    <text x="380" y="34" fill="#ffffff" font-size="12" font-weight="700" text-anchor="middle">Eris L2 Block Observation (obs)</text>

    <!-- Connection to Classifier -->
    <line x1="380" y1="48" x2="380" y2="70" stroke="#475569" stroke-width="2" marker-end="url(#arrow)" />

    <!-- Sub-10ms Classifier Node -->
    <rect x="230" y="70" width="300" height="36" rx="6" fill="#2563eb" filter="url(#shadow)" />
    <text x="380" y="93" fill="#ffffff" font-size="11.5" font-weight="700" text-anchor="middle">Sub-Millisecond Regime Classifier (0.4ms)</text>

    <!-- Fan out to 4 modules -->
    <path d="M 380 106 L 380 125 L 90 125 L 90 145" fill="none" stroke="#475569" stroke-width="1.8" marker-end="url(#arrow)" />
    <path d="M 380 106 L 380 125 L 285 125 L 285 145" fill="none" stroke="#475569" stroke-width="1.8" marker-end="url(#arrow)" />
    <path d="M 380 106 L 380 125 L 475 125 L 475 145" fill="none" stroke="#475569" stroke-width="1.8" marker-end="url(#arrow)" />
    <path d="M 380 106 L 380 125 L 670 125 L 670 145" fill="none" stroke="#475569" stroke-width="1.8" marker-end="url(#arrow)" />

    <!-- Module A -->
    <rect x="15" y="145" width="150" height="58" rx="6" fill="url(#gradModule)" stroke="#cbd5e1" stroke-width="1.5" filter="url(#shadow)" />
    <text x="90" y="167" fill="#0f172a" font-size="10.5" font-weight="700" text-anchor="middle">Module A: Convex AMM</text>
    <text x="90" y="184" fill="#64748b" font-size="8.5" text-anchor="middle">UniV3 / Curve / Balancer</text>

    <!-- Module B -->
    <rect x="205" y="145" width="160" height="58" rx="6" fill="url(#gradModule)" stroke="#cbd5e1" stroke-width="1.5" filter="url(#shadow)" />
    <text x="285" y="167" fill="#0f172a" font-size="10.5" font-weight="700" text-anchor="middle">Module B: Peg Stability</text>
    <text x="285" y="184" fill="#64748b" font-size="8.5" text-anchor="middle">eUSD Redemptions &amp; SP</text>

    <!-- Module C -->
    <rect x="395" y="145" width="160" height="58" rx="6" fill="url(#gradModule)" stroke="#cbd5e1" stroke-width="1.5" filter="url(#shadow)" />
    <text x="475" y="167" fill="#0f172a" font-size="10.5" font-weight="700" text-anchor="middle">Module C: Liquidations</text>
    <text x="475" y="184" fill="#64748b" font-size="8.5" text-anchor="middle">Aave V3 HF &amp; GMX Margin</text>

    <!-- Module D -->
    <rect x="590" y="145" width="160" height="58" rx="6" fill="url(#gradModule)" stroke="#cbd5e1" stroke-width="1.5" filter="url(#shadow)" />
    <text x="670" y="167" fill="#0f172a" font-size="10.5" font-weight="700" text-anchor="middle">Module D: LST Carry</text>
    <text x="670" y="184" fill="#64748b" font-size="8.5" text-anchor="middle">Staking Yield &amp; Discovery</text>

    <!-- Converge to Concave Sizer -->
    <path d="M 90 203 L 90 220 L 380 220 L 380 235" fill="none" stroke="#475569" stroke-width="1.8" />
    <path d="M 285 203 L 285 220 L 380 220" fill="none" stroke="#475569" stroke-width="1.8" />
    <path d="M 475 203 L 475 220 L 380 220" fill="none" stroke="#475569" stroke-width="1.8" />
    <path d="M 670 203 L 670 220 L 380 220" fill="none" stroke="#475569" stroke-width="1.8" marker-end="url(#arrow)" />

    <!-- Dynamic Sizer Node -->
    <rect x="220" y="235" width="320" height="36" rx="6" fill="url(#gradHighlight)" stroke="#2563eb" stroke-width="1.5" filter="url(#shadow)" />
    <text x="380" y="258" fill="#1e3a8a" font-size="11" font-weight="700" text-anchor="middle">Dynamic Concave Position Sizing q*(g) [35%–50%]</text>

    <!-- Connection to Net EV Gate -->
    <line x1="380" y1="271" x2="380" y2="290" stroke="#475569" stroke-width="1.8" marker-end="url(#arrow)" />

    <!-- Net EV Gate Node -->
    <rect x="190" y="290" width="380" height="36" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5" filter="url(#shadow)" />
    <text x="380" y="313" fill="#991b1b" font-size="10.5" font-weight="700" text-anchor="middle">Net-of-Gas EV Gate &amp; Anti-Frontrun Priority Filter</text>

    <!-- Connection to Action Dispatch -->
    <line x1="380" y1="326" x2="380" y2="342" stroke="#475569" stroke-width="1.8" marker-end="url(#arrow)" />

    <!-- Action Dispatch Node -->
    <rect x="250" y="342" width="260" height="26" rx="5" fill="#0f172a" filter="url(#shadow)" />
    <text x="380" y="359" fill="#ffffff" font-size="10" font-weight="700" text-anchor="middle">Signed EIP-1559 Action Dispatch</text>
  </svg>
</div>
`;

processedMd = processedMd.replace(/```mermaid[\s\S]+?```/g, mermaidSvg);

// 5. Parse Markdown with marked
marked.setOptions({
  gfm: true,
  breaks: false
});

let bodyHtml = marked.parse(processedMd);

// 6. Enhance Section Headers with Clean Page Breaks
bodyHtml = bodyHtml.replace(/<h3>1\. Architectural Overview/g, '<div class="page-break"></div><h3>1. Architectural Overview');
bodyHtml = bodyHtml.replace(/<h3>2\. Empirical LLM Forensics/g, '<div class="page-break"></div><h3>2. Empirical LLM Forensics');
bodyHtml = bodyHtml.replace(/<h3>3\. Live Chain Priority Fee Dynamics/g, '<div class="page-break"></div><h3>3. Live Chain Priority Fee Dynamics');
bodyHtml = bodyHtml.replace(/<h3>4\. Capital Efficiency/g, '<div class="page-break"></div><h3>4. Capital Efficiency');
bodyHtml = bodyHtml.replace(/<h3>5\. Verification, Reproducibility/g, '<div class="page-break"></div><h3>5. Verification, Reproducibility');

// 7. Inject KaTeX CSS
const katexCssPath = path.resolve('node_modules/katex/dist/katex.min.css');
let katexCss = fs.readFileSync(katexCssPath, 'utf8');
katexCss = katexCss.replace(/url\(fonts\//g, 'url(https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/fonts/');

// 8. Assemble Full Institutional HTML
const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Dynasty-Alpha Technical Report - ASCON Autonomous Trading Competition</title>
  <style>
    ${katexCss}

    @page {
      size: A4;
      margin: 15mm 14mm 16mm 14mm;
      @bottom-right {
        content: "Page " counter(page);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 7.5pt;
        color: #64748b;
      }
      @bottom-left {
        content: "ASCON Technical Report | Dynasty-Alpha (ASCON-S-00074)";
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 7.5pt;
        color: #64748b;
      }
    }

    *, *:before, *:after {
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 8.8pt;
      line-height: 1.48;
      color: #1e293b;
      background-color: #ffffff;
      margin: 0;
      padding: 0;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    .page-break {
      page-break-before: always;
    }

    /* Executive Cover Header */
    .report-banner {
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      color: #ffffff;
      padding: 16px 20px;
      border-radius: 6px;
      margin-bottom: 16px;
    }

    .report-title {
      font-size: 16pt;
      font-weight: 800;
      letter-spacing: -0.3px;
      margin: 0 0 4px 0;
      color: #ffffff;
      line-height: 1.2;
    }

    .report-subtitle {
      font-size: 10pt;
      font-weight: 500;
      color: #94a3b8;
      margin: 0 0 12px 0;
      line-height: 1.3;
    }

    .metadata-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 6px 14px;
      font-size: 8pt;
      background: rgba(255, 255, 255, 0.07);
      padding: 8px 12px;
      border-radius: 4px;
      border: 1px solid rgba(255, 255, 255, 0.12);
    }

    .metadata-item {
      display: flex;
      gap: 6px;
    }

    .metadata-label {
      color: #94a3b8;
      font-weight: 600;
    }

    .metadata-value {
      color: #f8fafc;
      font-weight: 500;
      font-family: "JetBrains Mono", Consolas, monospace;
    }

    .badge-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 10px;
    }

    .badge {
      display: inline-block;
      font-size: 7pt;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 2.5px 7px;
      border-radius: 3px;
    }

    .badge-gold {
      background: #fef08a;
      color: #854d0e;
      border: 1px solid #eab308;
    }

    .badge-blue {
      background: #dbeafe;
      color: #1e40af;
      border: 1px solid #93c5fd;
    }

    .badge-green {
      background: #dcfce7;
      color: #166534;
      border: 1px solid #86efac;
    }

    h1, h2, h3, h4, h5 {
      color: #0f172a;
      font-weight: 700;
      page-break-after: avoid;
    }

    h2 {
      font-size: 12pt;
      border-bottom: 1.5px solid #0f172a;
      padding-bottom: 4px;
      margin: 18px 0 8px 0;
    }

    h3 {
      font-size: 11pt;
      border-bottom: 1px solid #cbd5e1;
      padding-bottom: 3px;
      margin: 16px 0 8px 0;
      color: #0f172a;
    }

    h4 {
      font-size: 9.5pt;
      margin: 12px 0 5px 0;
      color: #1e293b;
    }

    h5 {
      font-size: 8.8pt;
      margin: 10px 0 4px 0;
      color: #334155;
    }

    p {
      margin: 0 0 7px 0;
      text-align: justify;
    }

    strong {
      color: #0f172a;
    }

    /* Professional Tables */
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 10px 0 14px 0;
      font-size: 7.2pt;
      line-height: 1.35;
      page-break-inside: avoid;
      font-variant-numeric: tabular-nums;
    }

    th {
      background-color: #0f172a;
      color: #ffffff;
      font-weight: 700;
      text-align: left;
      padding: 5px 6px;
      border: 1px solid #0f172a;
      letter-spacing: 0.2px;
    }

    td {
      padding: 4px 6px;
      border: 1px solid #cbd5e1;
      color: #334155;
    }

    tr:nth-child(even) td {
      background-color: #f8fafc;
    }

    /* Pre & Code */
    pre {
      background-color: #0f172a;
      color: #f8fafc;
      padding: 9px 12px;
      border-radius: 4px;
      font-family: "JetBrains Mono", Consolas, "Courier New", monospace;
      font-size: 7pt;
      line-height: 1.35;
      overflow-x: auto;
      margin: 8px 0 12px 0;
      page-break-inside: avoid;
      border: 1px solid #1e293b;
    }

    code {
      font-family: "JetBrains Mono", Consolas, "Courier New", monospace;
      font-size: 7.5pt;
      background-color: #f1f5f9;
      color: #0f172a;
      padding: 1px 3.5px;
      border-radius: 3px;
      border: 1px solid #e2e8f0;
    }

    pre code {
      background: none;
      color: inherit;
      padding: 0;
      border: none;
      font-size: 7pt;
    }

    /* Blockquotes / Callouts */
    blockquote {
      border-left: 3.5px solid #2563eb;
      background-color: #eff6ff;
      margin: 8px 0 12px 0;
      padding: 7px 12px;
      color: #1e3a8a;
      font-size: 8pt;
      border-radius: 0 4px 4px 0;
      page-break-inside: avoid;
    }

    blockquote p {
      margin: 0;
    }

    /* Lists */
    ul, ol {
      margin: 0 0 8px 0;
      padding-left: 18px;
    }

    li {
      margin-bottom: 3px;
    }

    /* Math */
    .math-display {
      margin: 8px 0;
      page-break-inside: avoid;
      text-align: center;
    }

    .svg-diagram-wrapper {
      margin: 10px 0 14px 0;
      page-break-inside: avoid;
      text-align: center;
    }

    /* Links */
    a {
      color: #2563eb;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="report-banner">
    <div class="report-title">Technical Report: Dynasty-Alpha</div>
    <div class="report-subtitle">Tri-Modal Adaptive Regime Engine &amp; Autonomous Sandboxed Execution under Adversarial L2 Priority Fee Dynamics</div>
    <div class="metadata-grid">
      <div class="metadata-item"><span class="metadata-label">Author / Participant:</span><span class="metadata-value">King Praise (Solo Entry)</span></div>
      <div class="metadata-item"><span class="metadata-label">Target Track:</span><span class="metadata-value">ASCON ¥2,000,000 Technical Report</span></div>
      <div class="metadata-item"><span class="metadata-label">Wallet Address:</span><span class="metadata-value">0xe40DA7Ac0ca9C21fe19527d31977184f0a82e6e2</span></div>
      <div class="metadata-item"><span class="metadata-label">Target Network:</span><span class="metadata-value">Eris L2 (Nyx Foundation, Chain ID 31337)</span></div>
      <div class="metadata-item"><span class="metadata-label">Submission ID:</span><span class="metadata-value">ASCON-S-00074 (Release V3)</span></div>
      <div class="metadata-item"><span class="metadata-label">Benchmark Standing:</span><span class="metadata-value">Score 64.03 (Rank #1 / 60 Epochs)</span></div>
    </div>
    <div class="badge-bar">
      <span class="badge badge-gold">Tournament Rank #1 (Score 64.03)</span>
      <span class="badge badge-green">0.00% On-Chain Reverts (193/193)</span>
      <span class="badge badge-blue">100.00% VM Sandbox Parity</span>
      <span class="badge badge-blue">99.9% Gas Reduction in V3</span>
    </div>
  </div>

  <div class="report-body">
    ${bodyHtml}
  </div>
</body>
</html>`;

fs.writeFileSync(htmlPath, fullHtml, 'utf8');
console.log('Polished HTML written to:', htmlPath);

// 9. Execute Chrome Print to PDF
console.log('Invoking Chrome to render executive PDF...');
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const chromeArgs = [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--run-all-compositor-stages-before-draw',
  `--print-to-pdf=${pdfPath}`,
  htmlPath
];

const res = spawnSync(chromePath, chromeArgs, { encoding: 'utf8' });
if (res.stderr) console.log('Chrome stderr:', res.stderr.trim());

if (fs.existsSync(pdfPath)) {
  const stats = fs.statSync(pdfPath);
  console.log(`\nSUCCESS: Executive PDF generated at: ${pdfPath}`);
  console.log(`PDF Size: ${(stats.size / 1024).toFixed(1)} KB`);
} else {
  console.error('\nFAILURE: PDF generation failed.');
}
