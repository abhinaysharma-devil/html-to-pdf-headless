# html-to-pdf-headless
 Here is the node pkg by you can create pdf in a simple way without any external headless browser like puppeteer etc.

# Dependency
 JSDOM, HTML-TO-PDFMAKE, PDFMAKE

# Install
 npm i html-to-pdf-headless

# Usage
const htmlToPdfHeadless = require("html-to-pdf-headless");
htmlToPdfHeadless.createPdf(HTML, styles)

# Styles
 styles = {
          "html-h1": {
            color: "#003366",
            background: "white",
          }
        }

# Note 
 It'll return the buffer you can convert in the raw file by Using # getBuffer method.
Example - htmlToPdfHeadless.createPdf(HTML, styles).getBuffer(function (buffer) {
      fs.writeFileSync({path}, buffer);
    })

