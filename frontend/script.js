// Relative URL: the Express server serves this page and the API from the same origin.
const API_URL = "/api/verify";
const INVALID_FILE_MESSAGE = "Invalid file type. Please select a .pkg package file.";

const form = document.getElementById("upload-form");
const packageNameInput = document.getElementById("packageName");
const usernameInput = document.getElementById("username");
const caseInput = document.getElementById("caseNumber");
const descInput = document.getElementById("description");
const fileInput = document.getElementById("file");
const dropzone = document.getElementById("dropzone");
const fileInfo = document.getElementById("file-info");
const fileNameEl = document.getElementById("file-name");
const fileSizeEl = document.getElementById("file-size");
const removeBtn = document.getElementById("remove-file");
const resultEl = document.getElementById("result");
const submitBtn = document.getElementById("submit-btn");

let selectedFile = null;

function setError(name, input, message) {
  document.getElementById(name + "-error").textContent = message;
  input.classList.toggle("invalid", Boolean(message));
}

function isPkg(file) {
  return Boolean(file) && file.name.toLowerCase().endsWith(".pkg");
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

function showResult(message, ok) {
  resultEl.hidden = false;
  resultEl.textContent = message;
  resultEl.className = "result " + (ok ? "success" : "failure");
}

// These fields are disabled: their values are only ever read from the package's //NOTES section.
const detailInputs = {
  packageName: packageNameInput,
  username: usernameInput,
  caseNumber: caseInput,
  description: descInput,
};
const autofillNote = document.getElementById("autofill-note");
let detailsRequest = 0;

function showAutofillNote(message) {
  autofillNote.hidden = !message;
  autofillNote.textContent = message || "";
}

function clearDetails() {
  for (const [key, input] of Object.entries(detailInputs)) {
    input.value = "";
    setError(key, input, "");
  }
  showAutofillNote("");
}

async function loadDetails(file) {
  const request = ++detailsRequest;
  clearDetails();
  showAutofillNote("Reading package details...");

  try {
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch("/api/package-info", { method: "POST", body: formData });

    let data;
    try {
      data = await response.json();
    } catch (parseError) {
      // An HTML page instead of JSON usually means the server is running older code.
      throw new Error(`the server sent an unexpected response (HTTP ${response.status}). Restart the server and refresh this page`);
    }
    if (request !== detailsRequest) return; // a newer file was chosen meanwhile
    if (!response.ok) throw new Error(data.message || "Server returned " + response.status);

    let found = 0;
    for (const [key, input] of Object.entries(detailInputs)) {
      input.value = data[key] || "";
      if (input.value) found++;
    }
    showAutofillNote(
      found
        ? "Details were read from the package //NOTES section."
        : "No details were found in the //NOTES section of this package."
    );
  } catch (err) {
    if (request !== detailsRequest) return;
    showAutofillNote("Could not read package details: " + err.message + ".");
  }
}

function clearFile() {
  detailsRequest++; // ignore any lookup still in flight
  selectedFile = null;
  fileInput.value = "";
  fileInfo.hidden = true;
  dropzone.hidden = false;
  clearDetails();
}

function handleFile(file) {
  resultEl.hidden = true;
  if (!file) return;

  if (!isPkg(file)) {
    clearFile();
    setError("file", dropzone, INVALID_FILE_MESSAGE);
    return;
  }

  selectedFile = file;
  setError("file", dropzone, "");
  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = formatSize(file.size);
  fileInfo.hidden = false;
  dropzone.hidden = true;
  loadDetails(file);
}

// The package file is the only required field. Every validation is attributed to a user,
// and that name can only come from the package, so a missing "Created By" blocks submit.
function checkUsername() {
  const ok = usernameInput.value.trim() !== "";
  setError(
    "username",
    usernameInput,
    ok ? "" : 'User Name was not found. Add a "Created By" line to the //NOTES section of the package.'
  );
  return ok;
}

function checkCase() {
  const value = caseInput.value.trim();
  const ok = value === "" || /^#?\d+$/.test(value);
  setError("caseNumber", caseInput, ok ? "" : "Case in the //NOTES section must be digits only.");
  return ok;
}

function checkFile() {
  let message = "";
  if (!selectedFile) message = "Package File is required.";
  else if (!isPkg(selectedFile)) message = INVALID_FILE_MESSAGE;
  setError("file", dropzone, message);
  return message === "";
}

// Clear a field's error as soon as the user edits it.

// File picker
dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener("change", () => handleFile(fileInput.files[0]));
removeBtn.addEventListener("click", () => {
  clearFile();
  setError("file", dropzone, "");
});

// Drag and drop
["dragenter", "dragover"].forEach((type) =>
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((type) =>
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  })
);
dropzone.addEventListener("drop", (e) => {
  const files = e.dataTransfer.files;
  if (files.length > 1) {
    clearFile();
    setError("file", dropzone, "Please drop a single .pkg file.");
    return;
  }
  handleFile(files[0]);
});

// Warning popup: the user must tick the checkbox before continuing to the results.
const warningDialog = document.getElementById("warning-dialog");
const warningList = document.getElementById("warning-list");
const warningConfirm = document.getElementById("warning-confirm");
const warningContinue = document.getElementById("warning-continue");
const warningBack = document.getElementById("warning-back");
const warningError = document.getElementById("warning-error");
let pendingRecordId = null;

function goToResults(recordId) {
  window.location.href = "results.html?id=" + encodeURIComponent(recordId);
}

function openWarningDialog(recordId, warnings) {
  pendingRecordId = recordId;
  warningList.replaceChildren();
  for (const warning of warnings) {
    const li = document.createElement("li");
    li.textContent = warning;
    warningList.appendChild(li);
  }
  warningConfirm.checked = false;
  warningContinue.disabled = true;
  warningError.textContent = "";
  warningDialog.showModal();
}

warningConfirm.addEventListener("change", () => {
  warningContinue.disabled = !warningConfirm.checked;
});

// Escape must not skip the acknowledgement.
warningDialog.addEventListener("cancel", (e) => e.preventDefault());

warningBack.addEventListener("click", () => warningDialog.close());

warningContinue.addEventListener("click", async () => {
  warningContinue.disabled = true;
  warningError.textContent = "";
  try {
    const response = await fetch("/api/history/" + encodeURIComponent(pendingRecordId) + "/acknowledge", { method: "POST" });
    if (!response.ok) throw new Error("Server returned " + response.status);
    goToResults(pendingRecordId);
  } catch (err) {
    warningError.textContent = "Could not save your confirmation: " + err.message;
    warningContinue.disabled = false;
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  resultEl.hidden = true;

  // Run every check so all errors show at once.
  const results = [checkFile(), checkUsername(), checkCase()];
  if (results.includes(false)) return;

  // Only the file is sent: the server reads the details from its //NOTES section itself.
  const formData = new FormData();
  formData.append("file", selectedFile);

  submitBtn.disabled = true;
  submitBtn.textContent = "Checking...";

  try {
    const response = await fetch(API_URL, { method: "POST", body: formData });
    const data = await response.json();

    // The package was validated and recorded (pass or fail).
    if (data.recordId) {
      if (data.valid && data.warnings && data.warnings.length) {
        openWarningDialog(data.recordId, data.warnings);
      } else {
        goToResults(data.recordId);
        return;
      }
    } else {
      showResult(data.message || "Something went wrong.", false);
    }
  } catch (err) {
    showResult("Could not reach the server: " + err.message, false);
  }
  submitBtn.disabled = false;
  submitBtn.textContent = "Submit";
});
