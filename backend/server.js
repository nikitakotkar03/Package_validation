const app = require("./app");
const { syncExcel, getStatus } = require("./excel");

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);

  // Add any validations saved before the Excel file existed (or while it was locked).
  syncExcel().then(() => {
    const { file, lastError } = getStatus();
    console.log(lastError ? `Excel: ${lastError}` : `Excel file: ${file}`);
  });
});
