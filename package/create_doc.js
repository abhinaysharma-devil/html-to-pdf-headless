/**
 * HTML to DOCX converter module.
 *
 * Walks a JSDOM document tree and builds docx (officegen) paragraph/table
 * structures that mirror the HTML content, reusing the same CSS-inlining
 * pipeline already used for PDF generation.
 */

const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, TableBorders, BorderStyle,
  AlignmentType, PageBreak, ExternalHyperlink, ImageRun,
  WidthType, ShadingType, convertInchesToTwip,
  UnderlineType, LevelFormat, HorizontalRule,
} = require("docx");
const { JSDOM } = require("jsdom");

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a CSS color string to a hex string without '#'.
 * Handles #rgb, #rrggbb, rgb(), rgba(), and common named colors.
 *
 * @param {String} color - CSS color value
 * @returns {String|null} 6-char hex string or null
 */
function cssColorToHex(color) {
  if (!color) return null;
  color = color.trim().toLowerCase();

  // Named colours (common subset)
  var named = {
    white: "FFFFFF", black: "000000", red: "FF0000", green: "008000",
    blue: "0000FF", yellow: "FFFF00", orange: "FFA500", purple: "800080",
    gray: "808080", grey: "808080", silver: "C0C0C0", maroon: "800000",
    navy: "000080", teal: "008080", aqua: "00FFFF", lime: "00FF00",
    olive: "808000", fuchsia: "FF00FF",
  };
  if (named[color]) return named[color];

  // #rrggbb
  var m = color.match(/^#([0-9a-f]{6})$/i);
  if (m) return m[1].toUpperCase();

  // #rgb → #rrggbb
  m = color.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (m) return (m[1]+m[1]+m[2]+m[2]+m[3]+m[3]).toUpperCase();

  // rgb(r, g, b) or rgba(r, g, b, a)
  m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) {
    var r = Math.min(255, parseInt(m[1], 10));
    var g = Math.min(255, parseInt(m[2], 10));
    var b = Math.min(255, parseInt(m[3], 10));
    return ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
  }

  return null;
}

// ---------------------------------------------------------------------------
// Style parsing
// ---------------------------------------------------------------------------

/**
 * Parse an element's inline style string into a style map.
 *
 * @param {HTMLElement} el - DOM element
 * @returns {Object} key-value map of CSS properties
 */
function getStyles(el) {
  var styleStr = el.getAttribute ? (el.getAttribute("style") || "") : "";
  var map = {};
  styleStr.split(";").forEach(function (part) {
    var idx = part.indexOf(":");
    if (idx < 0) return;
    var key = part.substring(0, idx).trim().toLowerCase();
    var val = part.substring(idx + 1).trim();
    if (key && val) map[key] = val;
  });
  return map;
}

/**
 * Build a TextRun options object from parsed CSS styles.
 *
 * @param {Object} styles - CSS style map from getStyles()
 * @returns {Object} docx TextRun options
 */
function textRunOpts(styles) {
  var opts = {};

  // Font
  if (styles["font-family"]) {
    opts.font = styles["font-family"].split(",")[0].trim().replace(/['"]/g, "");
  }

  // Size (half-points: 1pt = 2 half-points)
  if (styles["font-size"]) {
    var sz = parseFloat(styles["font-size"]);
    if (!isNaN(sz)) opts.size = Math.round(sz * 2);
  }

  // Bold
  if (styles["font-weight"] === "bold" || parseInt(styles["font-weight"], 10) >= 700) {
    opts.bold = true;
  }

  // Italic
  if (styles["font-style"] === "italic" || styles["font-style"] === "oblique") {
    opts.italics = true;
  }

  // Color
  var color = cssColorToHex(styles["color"]);
  if (color) opts.color = color;

  // Background / highlight
  var bg = styles["background-color"] || styles["background"];
  if (bg) {
    var bgHex = cssColorToHex(bg);
    if (bgHex) {
      opts.shading = { type: ShadingType.CLEAR, color: "auto", fill: bgHex };
    }
  }

  // Text decoration
  if (styles["text-decoration"]) {
    var dec = styles["text-decoration"];
    if (dec.indexOf("underline") > -1) opts.underline = { type: UnderlineType.SINGLE };
    if (dec.indexOf("line-through") > -1) opts.strike = true;
  }

  // Letter spacing
  if (styles["letter-spacing"]) {
    var ls = parseFloat(styles["letter-spacing"]);
    if (!isNaN(ls)) opts.characterSpacing = Math.round(ls * 20); // twips
  }

  return opts;
}

/**
 * Determine paragraph alignment from a style map.
 *
 * @param {Object} styles - CSS style map
 * @returns {String|undefined} docx AlignmentType value
 */
function getAlignment(styles) {
  var ta = styles["text-align"];
  if (!ta) return undefined;
  switch (ta) {
    case "center": return AlignmentType.CENTER;
    case "right":  return AlignmentType.RIGHT;
    case "justify": return AlignmentType.JUSTIFIED;
    default: return AlignmentType.LEFT;
  }
}

// ---------------------------------------------------------------------------
// DOM → docx conversion
// ---------------------------------------------------------------------------

/**
 * Collect all inline text runs from an element, recursively descending into
 * inline children (SPAN, B, I, EM, STRONG, A, U, S, etc.) while respecting
 * inherited styles.
 *
 * @param {HTMLElement} el - DOM element to extract runs from
 * @param {Object} inherited - Inherited TextRun options from parent
 * @returns {TextRun[]} Array of docx TextRun instances
 */
function collectRuns(el, inherited) {
  inherited = inherited || {};
  var runs = [];

  if (!el.childNodes) return runs;

  for (var i = 0; i < el.childNodes.length; i++) {
    var child = el.childNodes[i];

    if (child.nodeType === 3) {
      // Text node
      var txt = child.textContent;
      if (txt) {
        runs.push(new TextRun(Object.assign({}, inherited, { text: txt })));
      }
    } else if (child.nodeType === 1) {
      var tag = child.nodeName.toUpperCase();
      var childStyles = getStyles(child);
      var merged = Object.assign({}, inherited, textRunOpts(childStyles));

      switch (tag) {
        case "BR":
          runs.push(new TextRun({ break: 1 }));
          break;
        case "B":
        case "STRONG":
          merged.bold = true;
          runs = runs.concat(collectRuns(child, merged));
          break;
        case "I":
        case "EM":
          merged.italics = true;
          runs = runs.concat(collectRuns(child, merged));
          break;
        case "U":
          merged.underline = { type: UnderlineType.SINGLE };
          runs = runs.concat(collectRuns(child, merged));
          break;
        case "S":
        case "STRIKE":
        case "DEL":
          merged.strike = true;
          runs = runs.concat(collectRuns(child, merged));
          break;
        case "A":
          // Inline hyperlinks are converted to underlined blue text
          merged.color = "0563C1";
          merged.underline = { type: UnderlineType.SINGLE };
          runs = runs.concat(collectRuns(child, merged));
          break;
        case "SUP":
          merged.superScript = true;
          runs = runs.concat(collectRuns(child, merged));
          break;
        case "SUB":
          merged.subScript = true;
          runs = runs.concat(collectRuns(child, merged));
          break;
        case "CODE":
          merged.font = "Courier New";
          merged.shading = { type: ShadingType.CLEAR, color: "auto", fill: "F0F0F0" };
          runs = runs.concat(collectRuns(child, merged));
          break;
        case "SPAN":
        default:
          // Generic inline element — inherit current style
          runs = runs.concat(collectRuns(child, merged));
          break;
      }
    }
  }

  return runs;
}

/**
 * Build paragraph options (alignment, spacing, shading, border) from styles.
 *
 * @param {Object} styles - CSS style map
 * @returns {Object} Paragraph constructor options
 */
function paragraphOpts(styles) {
  var opts = {};

  // Alignment
  var align = getAlignment(styles);
  if (align) opts.alignment = align;

  // Background
  var bg = styles["background-color"] || styles["background"];
  if (bg) {
    var bgHex = cssColorToHex(bg);
    if (bgHex) {
      opts.shading = { type: ShadingType.CLEAR, color: "auto", fill: bgHex };
    }
  }

  // Border (simple solid border)
  if (styles["border"]) {
    var borderColor = "000000";
    var bm = styles["border"].match(/(#[0-9a-fA-F]{3,6}|\w+)\s*$/);
    if (bm) {
      var bc = cssColorToHex(bm[1]);
      if (bc) borderColor = bc;
    }
    var borderStyle = BorderStyle.SINGLE;
    if (styles["border"].indexOf("dashed") > -1) borderStyle = BorderStyle.DASHED;
    if (styles["border"].indexOf("dotted") > -1) borderStyle = BorderStyle.DOTTED;
    if (styles["border"].indexOf("double") > -1) borderStyle = BorderStyle.DOUBLE;

    opts.border = {
      top: { style: borderStyle, size: 1, color: borderColor },
      bottom: { style: borderStyle, size: 1, color: borderColor },
      left: { style: borderStyle, size: 1, color: borderColor },
      right: { style: borderStyle, size: 1, color: borderColor },
    };
  }

  // Margin → spacing (top/bottom as before/after)
  if (styles["margin-top"]) {
    var mt = parseFloat(styles["margin-top"]);
    if (!isNaN(mt)) opts.spacing = Object.assign(opts.spacing || {}, { before: Math.round(mt * 20) });
  }
  if (styles["margin-bottom"]) {
    var mb = parseFloat(styles["margin-bottom"]);
    if (!isNaN(mb)) opts.spacing = Object.assign(opts.spacing || {}, { after: Math.round(mb * 20) });
  }
  // Shorthand margin
  if (styles["margin"] && !styles["margin-top"] && !styles["margin-bottom"]) {
    var mParts = styles["margin"].trim().split(/\s+/);
    var mTop = parseFloat(mParts[0]) || 0;
    var mBottom = mParts.length >= 3 ? (parseFloat(mParts[2]) || 0) : mTop;
    if (mTop || mBottom) {
      opts.spacing = Object.assign(opts.spacing || {}, {
        before: Math.round(mTop * 20),
        after: Math.round(mBottom * 20),
      });
    }
  }

  return opts;
}

/**
 * Parse border shorthand (e.g. "1px solid black") into docx border parts.
 *
 * @param {String} borderStr - CSS border shorthand
 * @returns {Object} { style, size, color }
 */
function parseBorderShorthand(borderStr) {
  var style = BorderStyle.SINGLE;
  var size = 1;
  var color = "000000";

  if (!borderStr || borderStr === "none") return null;

  if (borderStr.indexOf("dashed") > -1) style = BorderStyle.DASHED;
  else if (borderStr.indexOf("dotted") > -1) style = BorderStyle.DOTTED;
  else if (borderStr.indexOf("double") > -1) style = BorderStyle.DOUBLE;

  var sizeMatch = borderStr.match(/(\d+(\.\d+)?)\s*px/);
  if (sizeMatch) size = Math.max(1, Math.round(parseFloat(sizeMatch[1])));

  var colorMatch = borderStr.match(/(#[0-9a-fA-F]{3,6}|\brgba?\([^)]+\)|\b[a-z]+)\s*$/i);
  if (colorMatch) {
    var c = cssColorToHex(colorMatch[1]);
    if (c) color = c;
  }

  return { style: style, size: size, color: color };
}

/**
 * Walk the DOM tree and convert HTML elements into docx elements (Paragraph,
 * Table, etc.).
 *
 * @param {HTMLElement} el - DOM element to process
 * @param {Object} ctx - Conversion context (numbering, list state, etc.)
 * @returns {Array} Array of docx elements (Paragraphs, Tables, etc.)
 */
function walkElement(el, ctx) {
  var elements = [];

  if (!el || !el.childNodes) return elements;

  for (var i = 0; i < el.childNodes.length; i++) {
    var child = el.childNodes[i];

    if (child.nodeType === 3) {
      // Top-level text node
      var txt = child.textContent.trim();
      if (txt) {
        elements.push(new Paragraph({ children: [new TextRun(txt)] }));
      }
      continue;
    }

    if (child.nodeType !== 1) continue;

    var tag = child.nodeName.toUpperCase();
    var styles = getStyles(child);
    var pOpts = paragraphOpts(styles);
    var tOpts = textRunOpts(styles);

    switch (tag) {
      case "H1":
        elements.push(new Paragraph(Object.assign({}, pOpts, {
          heading: HeadingLevel.HEADING_1,
          children: collectRuns(child, tOpts),
        })));
        break;
      case "H2":
        elements.push(new Paragraph(Object.assign({}, pOpts, {
          heading: HeadingLevel.HEADING_2,
          children: collectRuns(child, tOpts),
        })));
        break;
      case "H3":
        elements.push(new Paragraph(Object.assign({}, pOpts, {
          heading: HeadingLevel.HEADING_3,
          children: collectRuns(child, tOpts),
        })));
        break;
      case "H4":
        elements.push(new Paragraph(Object.assign({}, pOpts, {
          heading: HeadingLevel.HEADING_4,
          children: collectRuns(child, tOpts),
        })));
        break;
      case "H5":
        elements.push(new Paragraph(Object.assign({}, pOpts, {
          heading: HeadingLevel.HEADING_5,
          children: collectRuns(child, tOpts),
        })));
        break;
      case "H6":
        elements.push(new Paragraph(Object.assign({}, pOpts, {
          heading: HeadingLevel.HEADING_6,
          children: collectRuns(child, tOpts),
        })));
        break;

      case "P":
        elements.push(new Paragraph(Object.assign({}, pOpts, {
          children: collectRuns(child, tOpts),
        })));
        break;

      case "BR":
        elements.push(new Paragraph({ children: [] }));
        break;

      case "HR":
        elements.push(new Paragraph({
          children: [],
          border: {
            bottom: { style: BorderStyle.SINGLE, size: 1, color: "999999" },
          },
          spacing: { after: 120 },
        }));
        break;

      case "DIV":
      case "SECTION":
      case "ARTICLE":
      case "HEADER":
      case "FOOTER":
      case "MAIN":
      case "ASIDE":
      case "NAV":
      case "FORM": {
        // Check for page break via data-pdfmake or class
        var hasPageBreak = child.getAttribute("data-pdfmake") &&
          child.getAttribute("data-pdfmake").indexOf("pageBreakAfter") > -1;

        // Recurse into the div's children
        var divChildren = walkElement(child, ctx);
        elements = elements.concat(divChildren);

        // Insert page break if the element has page-break-after
        if (hasPageBreak || styles["page-break-after"] === "always") {
          elements.push(new Paragraph({ children: [new PageBreak()] }));
        }
        break;
      }

      case "SPAN": {
        // Inline span at block level — wrap in a paragraph
        var runs = collectRuns(child, tOpts);
        if (runs.length > 0) {
          elements.push(new Paragraph(Object.assign({}, pOpts, { children: runs })));
        }
        break;
      }

      case "A": {
        // Block-level link
        var linkText = child.textContent || "";
        var href = child.getAttribute("href") || "";
        if (href && linkText) {
          elements.push(new Paragraph({
            children: [
              new ExternalHyperlink({
                link: href,
                children: [new TextRun({
                  text: linkText,
                  color: "0563C1",
                  underline: { type: UnderlineType.SINGLE },
                })],
              }),
            ],
          }));
        } else {
          elements.push(new Paragraph({
            children: collectRuns(child, Object.assign({}, tOpts, {
              color: "0563C1",
              underline: { type: UnderlineType.SINGLE },
            })),
          }));
        }
        break;
      }

      case "UL":
      case "OL": {
        var listItems = child.querySelectorAll(":scope > li");
        var isOrdered = (tag === "OL");
        listItems.forEach(function (li) {
          var liStyles = getStyles(li);
          var liOpts = textRunOpts(liStyles);
          var liPOpts = paragraphOpts(liStyles);
          elements.push(new Paragraph(Object.assign({}, liPOpts, {
            children: collectRuns(li, liOpts),
            bullet: isOrdered ? undefined : { level: 0 },
            numbering: isOrdered ? { reference: ctx.numbering, level: 0 } : undefined,
          })));
        });
        // Advance numbering reference for next ordered list
        if (isOrdered) ctx.olIndex++;
        break;
      }

      case "TABLE": {
        var docxRows = [];
        var trs = child.querySelectorAll(":scope > thead > tr, :scope > tbody > tr, :scope > tr");

        trs.forEach(function (tr) {
          var trStyles = getStyles(tr);
          var cells = [];
          var tds = tr.querySelectorAll(":scope > td, :scope > th");

          tds.forEach(function (td) {
            var isHeader = (td.nodeName.toUpperCase() === "TH");
            var tdStyles = getStyles(td);

            // Cell content — recurse for block-level children, or collect runs
            var cellChildren = [];
            var hasBlockChildren = false;
            for (var ci = 0; ci < td.childNodes.length; ci++) {
              var cn = td.childNodes[ci];
              if (cn.nodeType === 1 && /^(P|DIV|TABLE|UL|OL|H[1-6])$/.test(cn.nodeName.toUpperCase())) {
                hasBlockChildren = true;
                break;
              }
            }

            if (hasBlockChildren) {
              cellChildren = walkElement(td, ctx);
            } else {
              var cellTOpts = textRunOpts(tdStyles);
              if (isHeader) cellTOpts.bold = true;
              cellChildren = [new Paragraph({
                alignment: getAlignment(tdStyles),
                children: collectRuns(td, cellTOpts),
              })];
            }

            // Ensure at least one paragraph in the cell
            if (cellChildren.length === 0) {
              cellChildren = [new Paragraph({ children: [] })];
            }

            // Cell options
            var cellOpts = { children: cellChildren };

            // colspan / rowspan
            var colspan = parseInt(td.getAttribute("colspan"), 10);
            if (colspan > 1) cellOpts.columnSpan = colspan;
            var rowspan = parseInt(td.getAttribute("rowspan"), 10);
            if (rowspan > 1) cellOpts.rowSpan = rowspan;

            // Cell background (from TD or inherited TR style)
            var cellBg = tdStyles["background-color"] || tdStyles["background"] ||
                         trStyles["background-color"] || trStyles["background"];
            var cellBgHex = cssColorToHex(cellBg);
            if (cellBgHex) {
              cellOpts.shading = { type: ShadingType.CLEAR, color: "auto", fill: cellBgHex };
            } else if (isHeader) {
              cellOpts.shading = { type: ShadingType.CLEAR, color: "auto", fill: "F2F2F2" };
            }

            // Cell borders
            var cellBorder = tdStyles["border"] || styles["border"];
            if (cellBorder) {
              var bp = parseBorderShorthand(cellBorder);
              if (bp) {
                cellOpts.borders = {
                  top: bp, bottom: bp, left: bp, right: bp,
                };
              }
            }

            // Cell width
            if (tdStyles["width"]) {
              var w = parseFloat(tdStyles["width"]);
              if (!isNaN(w)) {
                cellOpts.width = { size: w, type: WidthType.DXA };
              }
            }

            cells.push(new TableCell(cellOpts));
          });

          if (cells.length > 0) {
            docxRows.push(new TableRow({ children: cells }));
          }
        });

        if (docxRows.length > 0) {
          var tableOpts = { rows: docxRows };

          // Table width
          if (styles["width"] === "100%") {
            tableOpts.width = { size: 100, type: WidthType.PERCENTAGE };
          }

          elements.push(new Table(tableOpts));
        }
        break;
      }

      case "PRE": {
        // Preformatted text — preserve whitespace and use monospace font
        var preText = child.textContent || "";
        var preLines = preText.split("\n");
        preLines.forEach(function (line) {
          elements.push(new Paragraph({
            children: [new TextRun({
              text: line || " ",
              font: "Courier New",
              size: 20, // 10pt
            })],
            shading: { type: ShadingType.CLEAR, color: "auto", fill: "F5F5F5" },
          }));
        });
        break;
      }

      case "BLOCKQUOTE": {
        var bqRuns = collectRuns(child, Object.assign({}, tOpts, { italics: true, color: "666666" }));
        elements.push(new Paragraph(Object.assign({}, pOpts, {
          children: bqRuns,
          indent: { left: convertInchesToTwip(0.5) },
          border: {
            left: { style: BorderStyle.SINGLE, size: 3, color: "CCCCCC" },
          },
        })));
        break;
      }

      case "IMG": {
        // Image support — only base64 data URIs can be embedded
        var src = child.getAttribute("src") || "";
        if (src.startsWith("data:image/")) {
          try {
            var base64Data = src.split(",")[1];
            var imgBuffer = Buffer.from(base64Data, "base64");
            var imgWidth = parseInt(child.getAttribute("width"), 10) || 300;
            var imgHeight = parseInt(child.getAttribute("height"), 10) || 200;
            elements.push(new Paragraph({
              children: [new ImageRun({
                data: imgBuffer,
                transformation: { width: imgWidth, height: imgHeight },
              })],
            }));
          } catch (e) {
            elements.push(new Paragraph({
              children: [new TextRun({ text: "[Image]", color: "999999", italics: true })],
            }));
          }
        } else {
          // Remote images cannot be embedded — show placeholder
          elements.push(new Paragraph({
            children: [new TextRun({
              text: "[Image: " + src + "]",
              color: "999999",
              italics: true,
              size: 16,
            })],
          }));
        }
        break;
      }

      // Unsupported elements → placeholder
      case "CANVAS":
      case "IFRAME":
      case "AUDIO":
      case "VIDEO":
      case "SVG": {
        var labels = { CANVAS: "Canvas", IFRAME: "Frame", AUDIO: "Audio", VIDEO: "Video", SVG: "SVG" };
        elements.push(new Paragraph({
          children: [new TextRun({
            text: "[" + (labels[tag] || tag) + " Element]",
            color: "888888",
            italics: true,
          })],
          shading: { type: ShadingType.CLEAR, color: "auto", fill: "F5F5F5" },
          border: {
            top: { style: BorderStyle.DASHED, size: 1, color: "BBBBBB" },
            bottom: { style: BorderStyle.DASHED, size: 1, color: "BBBBBB" },
            left: { style: BorderStyle.DASHED, size: 1, color: "BBBBBB" },
            right: { style: BorderStyle.DASHED, size: 1, color: "BBBBBB" },
          },
          alignment: AlignmentType.CENTER,
        }));
        break;
      }

      default: {
        // Unknown block-level element — try to extract content
        var defRuns = collectRuns(child, tOpts);
        if (defRuns.length > 0) {
          elements.push(new Paragraph(Object.assign({}, pOpts, { children: defRuns })));
        } else {
          // Recurse into children
          var nested = walkElement(child, ctx);
          elements = elements.concat(nested);
        }
        break;
      }
    }
  }

  return elements;
}

/**
 * Convert an HTML string to a DOCX buffer.
 *
 * @param {String} html - The HTML string, after CSS inlining
 * @returns {Promise<Buffer>} Resolves with the DOCX file buffer
 */
function htmlToDocx(html) {
  var dom = new JSDOM(html);
  var document = dom.window.document;
  var body = document.body || document.documentElement;

  // Context for numbering (ordered lists)
  var ctx = {
    numbering: "default-numbering",
    olIndex: 0,
  };

  // Walk the DOM and collect all docx elements
  var docElements = walkElement(body, ctx);

  // Ensure at least one paragraph exists (Word requires it)
  if (docElements.length === 0) {
    docElements = [new Paragraph({ children: [] })];
  }

  // Build the document
  var doc = new Document({
    numbering: {
      config: [{
        reference: "default-numbering",
        levels: [{
          level: 0,
          format: LevelFormat.DECIMAL,
          text: "%1.",
          alignment: AlignmentType.START,
        }],
      }],
    },
    sections: [{
      children: docElements,
    }],
  });

  return Packer.toBuffer(doc);
}

module.exports = { htmlToDocx, cssColorToHex };
