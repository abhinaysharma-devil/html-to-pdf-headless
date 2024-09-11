const jsdom = require("jsdom");
const htmlToPdfMake = require("./html-to-pdfmake");
const createpdfdependency = require("./create_pdf_dependency")
const pdfFonts = require("./vfs_fonts");
createpdfdependency.vfs = pdfFonts.pdfMake.vfs;

const { JSDOM } = jsdom;
const { window } = new JSDOM("");

  exports.createPdf = (html, styles)=>{
    const htmll = htmlToPdfMake(html, {
      window
      });

    return createpdfdependency.createPdf({
      content: htmll,
      styles: styles
    }
     )
  }


