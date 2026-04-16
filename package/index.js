const jsdom = require("jsdom");
const fs = require("fs");
const path = require("path");
const htmlToPdfMake = require("./html-to-pdfmake");
const createpdfdependency = require("./create_pdf_dependency");
const pdfFonts = require("./vfs_fonts");
const { htmlToDocx } = require("./create_doc");
createpdfdependency.vfs = pdfFonts.pdfMake.vfs;

// Load standard PDF font AFM data into the virtual file system.
// This enables Times (serif), Courier (monospace), and Helvetica (sans-serif).
var afmDir = path.join(__dirname, "node_modules", "pdfkit", "js", "data");
var afmFiles = [
  "Courier.afm", "Courier-Bold.afm", "Courier-Oblique.afm", "Courier-BoldOblique.afm",
  "Helvetica.afm", "Helvetica-Bold.afm", "Helvetica-Oblique.afm", "Helvetica-BoldOblique.afm",
  "Times-Roman.afm", "Times-Bold.afm", "Times-Italic.afm", "Times-BoldItalic.afm",
  "ZapfDingbats.afm",
];
afmFiles.forEach(function (file) {
  var filePath = path.join(afmDir, file);
  if (fs.existsSync(filePath)) {
    createpdfdependency.vfs["data/" + file] = fs.readFileSync(filePath, "utf8");
  }
});

const { JSDOM } = jsdom;

/**
 * Inline CSS from <style> blocks into element style attributes.
 * html-to-pdfmake only reads inline styles, so we must pre-process the HTML
 * to move class/tag-based CSS rules into each element's style attribute.
 *
 * @param {String} html - The raw HTML string
 * @returns {String} - HTML with CSS rules inlined as style attributes
 */
function inlineCssStyles(html) {
  var dom = new JSDOM(html);
  var document = dom.window.document;

  // Collect all <style> blocks and parse CSS rules
  var styleElements = document.querySelectorAll("style");
  var cssRules = [];

  styleElements.forEach(function (styleEl) {
    var cssText = styleEl.textContent || "";

    // Remove @media blocks (not relevant for PDF) using brace counting
    var result = "";
    var i = 0;
    while (i < cssText.length) {
      var mediaMatch = cssText.substring(i).match(/^@media\b[^{]*/);
      if (mediaMatch) {
        // Found @media — skip ahead to its opening brace and count braces
        i += mediaMatch[0].length;
        if (i < cssText.length && cssText[i] === "{") {
          var depth = 1;
          i++;
          while (i < cssText.length && depth > 0) {
            if (cssText[i] === "{") depth++;
            else if (cssText[i] === "}") depth--;
            i++;
          }
        }
      } else {
        result += cssText[i];
        i++;
      }
    }
    cssText = result;

    // Strip CSS comments (/* ... */)
    cssText = cssText.replace(/\/\*[\s\S]*?\*\//g, "");

    // Parse individual CSS rules: selector { property: value; ... }
    var ruleRegex = /([^{}]+)\{([^{}]+)\}/g;
    var match;
    while ((match = ruleRegex.exec(cssText)) !== null) {
      var selectorGroup = match[1].trim();
      var declarations = match[2].trim();

      // Handle comma-separated selectors (e.g. "th, td")
      var selectors = selectorGroup.split(",");
      selectors.forEach(function (selector) {
        selector = selector.trim();
        if (selector && !selector.startsWith("@")) {
          cssRules.push({
            selector: selector,
            declarations: declarations,
            specificity: calculateSpecificity(selector),
          });
        }
      });
    }
  });

  // Sort by specificity (lower first, so higher specificity overrides later)
  cssRules.sort(function (a, b) {
    return a.specificity - b.specificity;
  });

  // Apply each CSS rule to matching elements
  cssRules.forEach(function (rule) {
    try {
      var elements = document.querySelectorAll(rule.selector);
      elements.forEach(function (el) {
        // Parse existing inline style
        var existingStyle = el.getAttribute("style") || "";

        // Parse the CSS declarations into individual properties
        var newDecls = rule.declarations
          .split(";")
          .map(function (d) {
            return d.trim();
          })
          .filter(function (d) {
            return d.length > 0;
          });

        // Build a map of existing inline properties (they take priority)
        var existingProps = {};
        existingStyle
          .split(";")
          .forEach(function (d) {
            var parts = d.split(":");
            if (parts.length >= 2) {
              existingProps[parts[0].trim().toLowerCase()] = true;
            }
          });

        // Append only CSS properties that aren't already set inline
        var additions = [];
        newDecls.forEach(function (decl) {
          var prop = decl.split(":")[0];
          if (prop) {
            prop = prop.trim().toLowerCase();
            if (!existingProps[prop]) {
              additions.push(decl);
            }
          }
        });

        if (additions.length > 0) {
          var combined = existingStyle.replace(/;\s*$/, "");
          if (combined) combined += "; ";
          combined += additions.join("; ");
          el.setAttribute("style", combined);
        }
      });
    } catch (e) {
      // Skip invalid CSS selectors (e.g. unsupported pseudo-classes)
    }
  });

  // Propagate background/background-color from <tr> to child <td>/<th>
  // pdfmake uses fillColor on cells, not on rows. So row-level backgrounds
  // must be pushed down to each cell that doesn't already have one.
  var allTrs = document.querySelectorAll("tr");
  allTrs.forEach(function (tr) {
    var trStyle = tr.getAttribute("style") || "";
    var bgMatch = trStyle.match(/background(?:-color)?\s*:\s*([^;]+)/i);
    if (bgMatch) {
      var bgValue = bgMatch[1].trim();
      var cells = tr.querySelectorAll("td, th");
      cells.forEach(function (cell) {
        var cellStyle = cell.getAttribute("style") || "";
        // Only add if cell doesn't already have a background
        if (!cellStyle.match(/background(-color)?\s*:/i)) {
          var newCellStyle = cellStyle.replace(/;\s*$/, "");
          if (newCellStyle) newCellStyle += "; ";
          newCellStyle += "background-color: " + bgValue;
          cell.setAttribute("style", newCellStyle);
        }
      });
    }
  });

  // Mark flex containers with a data attribute so sanitizeDocDefinition
  // can convert them from stack (column layout) to pdfmake columns (row layout).
  var allElements = document.querySelectorAll("*");
  allElements.forEach(function (el) {
    var elStyle = el.getAttribute("style") || "";
    if (elStyle.match(/display\s*:\s*flex/i)) {
      el.classList.add("pdf-flex-container");
    }
    // Mark elements with dashed or dotted borders for table wrapper conversion.
    if (elStyle.match(/border[^:]*:\s*[^;]*dashed/i) || elStyle.match(/border-style\s*:\s*dashed/i)) {
      el.classList.add("pdf-dashed-border");
    }
    if (elStyle.match(/border[^:]*:\s*[^;]*dotted/i) || elStyle.match(/border-style\s*:\s*dotted/i)) {
      el.classList.add("pdf-dotted-border");
    }
  });

  // Convert page-break-after on .page divs to a data-pdfmake attribute
  // that html-to-pdfmake understands, preventing it from leaking to children.
  var pageDivs = document.querySelectorAll(".page");
  pageDivs.forEach(function (div, index) {
    var divStyle = div.getAttribute("style") || "";
    // Remove page-break-after from inline style to prevent inheritance
    divStyle = divStyle.replace(/page-break-after\s*:\s*[^;]+;?/gi, "").trim();
    // Remove border from .page divs — these are container decoration for HTML only
    divStyle = divStyle.replace(/border\s*:[^;]+;?/gi, "").trim();
    div.setAttribute("style", divStyle);
    // Set page break via data-pdfmake — skip the last page to avoid a trailing blank page
    if (index < pageDivs.length - 1) {
      div.setAttribute("data-pdfmake", '{"pageBreakAfter":"always"}');
    }
  });

  // Convert <form> to a <div> so its children render properly
  var forms = document.querySelectorAll("form");
  forms.forEach(function (form) {
    var div = document.createElement("div");
    div.innerHTML = form.innerHTML;
    var style = form.getAttribute("style");
    if (style) div.setAttribute("style", style);
    form.parentNode.replaceChild(div, form);
  });

  // Convert overflow-constrained boxes to have explicit width for pdfmake
  var overflowBoxes = document.querySelectorAll(".overflow-box");
  overflowBoxes.forEach(function (box) {
    var style = box.getAttribute("style") || "";
    // Remove overflow since pdfmake will clip via width
    style = style.replace(/overflow\s*:[^;]+;?/gi, "").trim();
    box.setAttribute("style", style);
  });

  // Convert RTL elements — pdfmake doesn't support direction: rtl natively.
  // Right-align the text to approximate RTL behavior.
  var rtlElements = document.querySelectorAll(".rtl, [dir='rtl']");
  rtlElements.forEach(function (el) {
    var style = el.getAttribute("style") || "";
    if (!style.match(/text-align/i)) {
      style += "; text-align: right;";
      el.setAttribute("style", style);
    }
  });

  // Convert form elements to visible text representations.
  // PDFs can't render interactive form elements, so show their values
  // in a styled format that resembles actual form fields.
  // Use background colors since pdfmake renders inline background but NOT inline borders.
  var inputs = document.querySelectorAll("input");
  inputs.forEach(function (input) {
    var type = (input.getAttribute("type") || "text").toLowerCase();
    var value = input.getAttribute("value") || "";
    var span = document.createElement("span");
    switch (type) {
      case "checkbox":
        if (input.hasAttribute("checked")) {
          span.textContent = " Yes ";
          span.setAttribute("style", "font-size: 10px; background-color: #4CAF50; color: white;");
        } else {
          span.textContent = " No ";
          span.setAttribute("style", "font-size: 10px; background-color: #e0e0e0; color: #666;");
        }
        break;
      case "radio":
        if (input.hasAttribute("checked")) {
          span.textContent = " Selected ";
          span.setAttribute("style", "font-size: 10px; background-color: #2196F3; color: white;");
        } else {
          span.textContent = " - ";
          span.setAttribute("style", "font-size: 10px; background-color: #e0e0e0; color: #666;");
        }
        break;
      case "password":
        span.textContent = " " + "*".repeat(Math.min(value.length || 5, 10)) + " ";
        span.setAttribute("style", "background-color: #f0f0f0; letter-spacing: 3px;");
        break;
      default:
        span.textContent = " " + (value || "\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0") + " ";
        span.setAttribute("style", "background-color: #f0f0f0;");
    }
    input.parentNode.replaceChild(span, input);
  });

  // Convert <select> to text showing selected option with dropdown indicator
  var selects = document.querySelectorAll("select");
  selects.forEach(function (sel) {
    var firstOption = sel.querySelector("option");
    var span = document.createElement("span");
    span.textContent = " " + (firstOption ? firstOption.textContent : "---") + " (v) ";
    span.setAttribute("style", "background-color: #f0f0f0; font-size: 10px;");
    sel.parentNode.replaceChild(span, sel);
  });

  // Convert <textarea> to text showing its content
  var textareas = document.querySelectorAll("textarea");
  textareas.forEach(function (ta) {
    var span = document.createElement("span");
    span.textContent = " " + (ta.textContent || "") + " ";
    span.setAttribute("style", "background-color: #f0f0f0;");
    ta.parentNode.replaceChild(span, ta);
  });

  // Replace unsupported HTML elements with placeholder text.
  var unsupportedTags = [
    { sel: "canvas",  label: "[Canvas Element]" },
    { sel: "iframe",  label: "[Embedded Frame]" },
    { sel: "audio",   label: "[Audio Player]" },
    { sel: "video",   label: "[Video Player]" },
    { sel: "svg",     label: "[SVG Graphic]" },
  ];
  unsupportedTags.forEach(function (tag) {
    var elements = document.querySelectorAll(tag.sel);
    elements.forEach(function (el) {
      var placeholder = document.createElement("div");
      placeholder.textContent = tag.label;
      placeholder.setAttribute("style",
        "background: #f5f5f5; border: 1px dashed #bbb; padding: 8px; " +
        "color: #888; font-style: italic; text-align: center; margin: 5px 0;"
      );
      el.parentNode.replaceChild(placeholder, el);
    });
  });

  // Handle gradient backgrounds — extract the first and last color stops
  // and apply the first color as background-color for a solid fallback.
  // Gradient format: linear-gradient(direction, color1, color2, ...)
  allElements.forEach(function (el) {
    var elStyle = el.getAttribute("style") || "";
    var gradientMatch = elStyle.match(
      /background\s*:\s*linear-gradient\(\s*(?:to\s+\w+(?:\s+\w+)?|[\d.]+deg)\s*,\s*([^,)]+)/i
    );
    if (gradientMatch) {
      var firstColor = gradientMatch[1].trim();
      // Replace the gradient with a solid background-color
      elStyle = elStyle.replace(/background\s*:[^;]+;?/i, "background-color: " + firstColor + ";");
      el.setAttribute("style", elStyle);
    }
  });

  // Simulate box-shadow with a subtle gray border where original had shadow.
  // pdfmake doesn't support shadow, so we approximate with a visible border.
  allElements.forEach(function (el) {
    var elStyle = el.getAttribute("style") || "";
    if (elStyle.match(/box-shadow\s*:/i)) {
      // Remove box-shadow and add a gray border to simulate depth
      elStyle = elStyle.replace(/box-shadow\s*:[^;]+;?/gi, "").trim();
      if (!elStyle.match(/border\s*:/i)) {
        elStyle += "; border: 1px solid #ccc;";
      }
      // Add a light background to give the shadow panel effect
      if (!elStyle.match(/background(-color)?\s*:/i)) {
        elStyle += "; background-color: #fafafa;";
      }
      el.setAttribute("style", elStyle);
    }
  });

  return dom.serialize();
}

/**
 * Calculate a simple CSS specificity score for sorting rules.
 * IDs = 100, classes/attributes = 10, elements = 1
 *
 * @param {String} selector - CSS selector string
 * @returns {Number} specificity score
 */
function calculateSpecificity(selector) {
  var score = 0;
  // Count IDs
  var ids = selector.match(/#/g);
  if (ids) score += ids.length * 100;
  // Count classes and attribute selectors
  var classes = selector.match(/\.|[\[]/g);
  if (classes) score += classes.length * 10;
  // Count element selectors (letters not preceded by # or . or [)
  var elements = selector.match(/(^|[\s+>~])[\w-]+/g);
  if (elements) score += elements.length;
  return score;
}

/**
 * Recursively sanitize the pdfmake document definition.
 * Removes tables with empty bodies and cleans up unsupported properties
 * to prevent pdfmake from crashing.
 *
 * @param {Object|Array} node - A pdfmake document definition node
 * @returns {Object|Array} - The sanitized node
 */
function sanitizeDocDefinition(node) {
  if (!node || typeof node !== 'object') return node;

  if (Array.isArray(node)) {
    return node
      .map(function(item) { return sanitizeDocDefinition(item); })
      .filter(function(item) {
        if (item === null || item === undefined) return false;
        // Remove whitespace-only text nodes that sit at the top level
        // between page divs, which inherit body margin and create gaps.
        // Only filter if the node has margin (indicating it's a body spacer).
        if (typeof item === 'object' && !Array.isArray(item) &&
            typeof item.text === 'string' && item.text.trim() === '' &&
            !item.stack && !item.table && !item.columns &&
            !item.pageBreakAfter && !item.pageBreakBefore &&
            item.margin) {
          return false;
        }
        return true;
      });
  }

  // Fix tables with empty body arrays — convert to a stack or text
  if (node.table && Array.isArray(node.table.body)) {
    // Remove any empty rows from the table body
    node.table.body = node.table.body.filter(function(row) {
      return Array.isArray(row) && row.length > 0;
    });

    // If table body is completely empty, convert to a simple container
    if (node.table.body.length === 0) {
      delete node.table;
      if (!node.stack && !node.text) {
        node.text = '';
      }
      return node;
    }

    // Ensure all rows have the same number of columns (pad shorter rows)
    var maxCols = 0;
    node.table.body.forEach(function(row) {
      if (row.length > maxCols) maxCols = row.length;
    });
    node.table.body.forEach(function(row) {
      while (row.length < maxCols) {
        row.push({ text: '' });
      }
    });

    // Sanitize each cell recursively
    node.table.body = node.table.body.map(function(row) {
      return row.map(function(cell) { return sanitizeDocDefinition(cell); });
    });
  }

  // Remove CSS-only properties that pdfmake does not understand
  var unsupportedProps = [
    'display', 'maxWidth', 'minWidth', 'maxHeight', 'minHeight',
    'boxSizing', 'borderCollapse', 'borderRadius', 'borderSpacing',
    'verticalAlign', 'overflow', 'position', 'float', 'clear',
    'visibility', 'cursor', 'zIndex', 'outline', 'boxShadow',
    'textShadow', 'transform', 'transition', 'animation',
    'WebkitFontSmoothing', 'MsTextSizeAdjust', 'WebkitTextSizeAdjust',
    'flex', 'gap', 'top', 'left', 'right', 'bottom', 'writingMode',
  ];
  unsupportedProps.forEach(function(prop) {
    if (node.hasOwnProperty(prop)) delete node[prop];
  });

  // Simulate vertical text — pdfmake cannot render writing-mode: vertical-rl.
  // Split each character on its own line to approximate vertical layout.
  if (node.style && Array.isArray(node.style) &&
      node.style.indexOf('vertical') > -1 &&
      typeof node.text === 'string' && node.text.trim()) {
    var chars = node.text.trim().split('');
    node.text = chars.join('\n');
    node.width = 20;
  }

  // When a table cell has fillColor (cell background), remove the inherited
  // 'background' property. pdfmake renders 'background' as a rectangle behind
  // the text ON TOP of fillColor, which can make text invisible.
  if (node.fillColor && node.hasOwnProperty('background')) {
    delete node.background;
  }

  // Add padding to inline badge-like spans.
  // pdfmake's 'background' property on text draws a tight rectangle.
  // Padding the text with spaces and increasing lineHeight simulates the
  // HTML badge padding effect (padding: 3px 8px).
  if (node.background && node.nodeName === 'SPAN' &&
      node.style && Array.isArray(node.style) && node.style.indexOf('badge') > -1 &&
      typeof node.text === 'string') {
    node.text = '\u00A0' + node.text + '\u00A0';
    node.lineHeight = 1.35;
  }

  // Map CSS font families to pdfmake-supported fonts.
  // pdfmake has Roboto, Times (serif), and Courier (monospace) registered.
  if (node.font) {
    var fontLower = node.font.toLowerCase();
    // Serif fonts -> Times
    if (['Georgia', 'TimesNewRoman', 'Times', 'Garamond', 'Palatino',
         'BookAntiqua', 'Cambria'].indexOf(node.font) > -1 ||
        fontLower === 'serif') {
      node.font = 'Times';
    }
    // Monospace fonts -> Courier
    else if (['CourierNew', 'Courier', 'Monospace', 'Consolas',
              'LucidaConsole', 'Monaco'].indexOf(node.font) > -1 ||
             fontLower === 'monospace') {
      node.font = 'Courier';
    }
    // Everything else -> Roboto (default sans-serif)
    else if (node.font !== 'Roboto' && node.font !== 'Times' && node.font !== 'Courier') {
      delete node.font;
    }
  }

  // Handle remote image URLs — pdfmake in Node.js cannot fetch remote URLs.
  // Replace with a text placeholder to avoid crashes.
  if (node.image && typeof node.image === 'string' &&
      !node.image.startsWith('data:') && !require('path').isAbsolute(node.image)) {
    var imgUrl = node.image;
    delete node.image;
    node.text = '[Image: ' + imgUrl + ']';
    node.color = '#999999';
    node.fontSize = 8;
    node.italics = true;
  }

  // Recursively sanitize nested content (stack, text arrays, columns, etc.)
  if (Array.isArray(node.stack)) {
    node.stack = sanitizeDocDefinition(node.stack);
  }
  if (Array.isArray(node.text)) {
    node.text = sanitizeDocDefinition(node.text);
  }
  if (Array.isArray(node.columns)) {
    node.columns = sanitizeDocDefinition(node.columns);
  }
  if (Array.isArray(node.ul)) {
    node.ul = sanitizeDocDefinition(node.ul);
  }
  if (Array.isArray(node.ol)) {
    node.ol = sanitizeDocDefinition(node.ol);
  }

  // Convert flex container stacks into pdfmake columns.
  // Elements with display:flex are marked with the "pdf-flex-container" class
  // in inlineCssStyles. Their children (stack items) inherit this class.
  // Detect parent stacks where all children share the class and convert to columns.
  if (node.stack && Array.isArray(node.stack) && node.stack.length > 1) {
    var allChildrenFlex = node.stack.every(function (child) {
      return child && child.style && Array.isArray(child.style) &&
             child.style.indexOf('pdf-flex-container') > -1;
    });
    if (allChildrenFlex) {
      node.columns = node.stack.map(function (child) {
        child.width = '*';
        // Clean up CSS properties pdfmake doesn't understand
        delete child.flex;
        delete child.gap;
        return child;
      });
      node.columnGap = 8;
      delete node.stack;
    }
  }

  // Wrap block-level elements (DIV, P) with borders or backgrounds in single-cell
  // tables. pdfmake only renders borders on table cells, and 'background' on text
  // only colors behind the characters — not a full-width block like CSS does.
  // This universal wrapper converts them to proper table cells so borders and
  // colored backgrounds actually render in the PDF.
  if ((node.nodeName === 'DIV' || node.nodeName === 'P') &&
      !node.table && !node.columns) {
    var hasBorderWrap = node.border && Array.isArray(node.border);
    var hasBgWrap = node.background && typeof node.background === 'string';

    if (hasBorderWrap || hasBgWrap) {
      // Build inner content node
      var wrapInner = {};
      if (node.text !== undefined) {
        wrapInner.text = node.text;
      } else if (node.stack) {
        wrapInner.stack = node.stack;
      } else {
        wrapInner.text = '';
      }

      // Move text/display properties to inner node
      ['alignment', 'color', 'fontSize', 'bold', 'italics', 'font',
       'characterSpacing', 'lineHeight', 'decoration'].forEach(function(p) {
        if (node.hasOwnProperty(p)) {
          wrapInner[p] = node[p]; delete node[p];
        }
      });

      // Per-side border flags: pdfmake border array is [left, top, right, bottom]
      var borderSides = hasBorderWrap ? node.border : [false, false, false, false];
      var bColor = node.borderColor || ['#000', '#000', '#000', '#000'];
      var bgC = hasBgWrap ? node.background : null;

      // For dashed/dotted borders (detected in CSS inliner)
      var isDashed = node.style && Array.isArray(node.style) &&
        (node.style.indexOf('pdf-dashed-border') > -1 ||
         node.style.indexOf('box') > -1);
      var isDotted = node.style && Array.isArray(node.style) &&
        node.style.indexOf('pdf-dotted-border') > -1;

      // Handle explicit width for narrow containers (e.g., vertical text)
      var colWidth = '*';
      if (node.width && typeof node.width === 'number') {
        colWidth = node.width;
      }

      // For empty colored blocks (layer divs, etc.), simulate height via padding
      var padT = 4, padB = 4;
      var isEmpty = (!wrapInner.text || (typeof wrapInner.text === 'string' && !wrapInner.text.trim())) &&
                    !wrapInner.stack;
      if (isEmpty && node.height && typeof node.height === 'number') {
        padT = Math.max(Math.floor(node.height / 2) - 4, 6);
        padB = padT;
        wrapInner.text = ' ';
      }

      // Clean up outer node properties that are now handled by the wrapper
      delete node.border; delete node.borderColor; delete node.background;
      delete node.text; delete node.stack;
      delete node.width; delete node.height;

      // Build table wrapper with per-side border control.
      // pdfmake layout functions receive (i, node) where i is the line index:
      //   hLineWidth(i): i=0 is top edge, i=1 is bottom edge (for 1-row table)
      //   vLineWidth(i): i=0 is left edge, i=1 is right edge (for 1-col table)
      node.table = { widths: [colWidth], body: [[wrapInner]] };
      node.layout = {
        hLineWidth: function(i) {
          // i=0 → top border (index 1), i=1 → bottom border (index 3)
          if (i === 0) return borderSides[1] ? 1 : 0;
          return borderSides[3] ? 1 : 0;
        },
        vLineWidth: function(i) {
          // i=0 → left border (index 0), i=1 → right border (index 2)
          if (i === 0) return borderSides[0] ? 1 : 0;
          return borderSides[2] ? 1 : 0;
        },
        hLineColor: function(i) {
          return i === 0 ? bColor[1] : bColor[3];
        },
        vLineColor: function(i) {
          return i === 0 ? bColor[0] : bColor[2];
        },
        paddingLeft: function() { return 6; },
        paddingRight: function() { return 6; },
        paddingTop: function() { return padT; },
        paddingBottom: function() { return padB; },
      };

      if (isDashed || isDotted) {
        var dLen = isDotted ? 2 : 5;
        var dSpc = isDotted ? 2 : 3;
        node.layout.hLineStyle = function() { return { dash: { length: dLen, space: dSpc } }; };
        node.layout.vLineStyle = function() { return { dash: { length: dLen, space: dSpc } }; };
      }

      if (bgC) {
        node.layout.fillColor = function() { return bgC; };
      }
    }
  }

  // Replace Unicode symbols unsupported by the bundled Roboto font subset.
  // ZapfDingbats (standard PDF font) has checkmarks, crosses, stars, and phones.
  // Characters not in ZapfDingbats get clean text fallbacks.
  // ZapfDingbats uses its own encoding — Unicode chars must be mapped to byte positions.
  var symbolMap = {
    '\u2714': { char: String.fromCharCode(52),  font: 'ZapfDingbats' }, // ✔ → position 52
    '\u2713': { char: String.fromCharCode(51),  font: 'ZapfDingbats' }, // ✓ → position 51
    '\u2716': { char: String.fromCharCode(54),  font: 'ZapfDingbats' }, // ✖ → position 54
    '\u2717': { char: String.fromCharCode(55),  font: 'ZapfDingbats' }, // ✗ → position 55
    '\u2605': { char: String.fromCharCode(72),  font: 'ZapfDingbats' }, // ★ → position 72 (star)
    '\u260E': { char: String.fromCharCode(37),  font: 'ZapfDingbats' }, // ☎ → position 37
    '\u2615': { char: '(coffee)', font: null },                         // ☕ — not in ZapfDingbats
    '\u2699': { char: '(gear)',   font: null },                         // ⚙ — not in ZapfDingbats
  };
  if (typeof node.text === 'string') {
    var hasSymbols = false;
    var symbolKeys = Object.keys(symbolMap);
    for (var si = 0; si < symbolKeys.length; si++) {
      if (node.text.indexOf(symbolKeys[si]) > -1) { hasSymbols = true; break; }
    }
    if (hasSymbols) {
      // Split text into segments, replacing symbols with font-switched fragments
      var segments = [];
      var remaining = node.text;
      while (remaining.length > 0) {
        var earliestIdx = remaining.length;
        var earliestSym = null;
        symbolKeys.forEach(function (sym) {
          var idx = remaining.indexOf(sym);
          if (idx > -1 && idx < earliestIdx) {
            earliestIdx = idx;
            earliestSym = sym;
          }
        });
        if (earliestSym === null) {
          segments.push(remaining);
          break;
        }
        if (earliestIdx > 0) {
          segments.push(remaining.substring(0, earliestIdx));
        }
        var mapped = symbolMap[earliestSym];
        if (mapped.font) {
          segments.push({ text: mapped.char, font: mapped.font });
        } else {
          segments.push(mapped.char);
        }
        remaining = remaining.substring(earliestIdx + earliestSym.length);
      }
      if (segments.length > 1 || (segments.length === 1 && typeof segments[0] !== 'string')) {
        node.text = segments;
      }
    }
  }

  return node;
}

exports.createPdf = (html, styles) => {
  // Inline CSS from <style> blocks so html-to-pdfmake can read them
  var processedHtml = inlineCssStyles(html);

  // Create a fresh JSDOM window for html-to-pdfmake
  var pdfWindow = new JSDOM("").window;

  const htmll = htmlToPdfMake(processedHtml, {
    window: pdfWindow,
    removeExtraBlanks: true,
    tableAutoSize: true,
  });

  // Sanitize the document definition to prevent pdfmake crashes
  const sanitizedContent = sanitizeDocDefinition(htmll);

  // Register standard PDF fonts alongside Roboto
  var fonts = {
    Roboto: {
      normal: 'Roboto-Regular.ttf',
      bold: 'Roboto-Medium.ttf',
      italics: 'Roboto-Italic.ttf',
      bolditalics: 'Roboto-MediumItalic.ttf',
    },
    Times: {
      normal: 'Times-Roman',
      bold: 'Times-Bold',
      italics: 'Times-Italic',
      bolditalics: 'Times-BoldItalic',
    },
    Courier: {
      normal: 'Courier',
      bold: 'Courier-Bold',
      italics: 'Courier-Oblique',
      bolditalics: 'Courier-BoldOblique',
    },
    ZapfDingbats: {
      normal: 'ZapfDingbats',
      bold: 'ZapfDingbats',
      italics: 'ZapfDingbats',
      bolditalics: 'ZapfDingbats',
    },
  };

  return createpdfdependency.createPdf(
    {
      content: sanitizedContent,
      styles: styles,
      defaultStyle: {
        font: 'Roboto',
      },
    },
    null, // tableLayouts
    fonts
  );
};

/**
 * Convert HTML to a DOCX document buffer.
 * Uses the same CSS inlining pipeline as createPdf to ensure consistent
 * style handling, then converts the DOM into docx elements.
 *
 * @param {String} html - HTML string to convert
 * @returns {Promise<Buffer>} Resolves with the .docx file buffer
 */
exports.createDocFile = (html) => {
  // Inline CSS from <style> blocks (same as PDF pipeline)
  var processedHtml = inlineCssStyles(html);
  return htmlToDocx(processedHtml);
};

