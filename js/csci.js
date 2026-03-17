
//--------------------------------------------------
async function showSignInModal() {
  $('#judge0-csci-sign-in-modal')
    .modal({ closable: false }).modal('show');
}
async function hideSignInModal()
{
$('#judge0-csci-sign-in-modal').modal('hide');
}

// csci.js (frontend, running on port 4000)
async function signIn(e) {
  if (e) e.preventDefault();

  const usernameInput = document.getElementById("modal_email");
  const passwordInput = document.getElementById("modal_password");
  const username = usernameInput.value;
  const password = passwordInput.value;

  const $signInBtn = $("#judge0-csci-modal-sign-in-btn");
  $signInBtn.addClass("loading disabled");

  try {
    const response = await fetch("/ssh-sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    const result = await response.json();

    if (result.success) {
      // Clear credentials from DOM immediately after successful login
      passwordInput.value = "";
      alert("Connected to CSCI server!");
      $('#judge0-csci-sign-in-modal').modal('hide');
    } else {
      alert("Login failed: " + result.error);
    }
  } catch (err) {
    console.error("Fetch error:", err);
    alert("Error connecting to server. See console for details.");
  } finally {
    $signInBtn.removeClass("loading disabled");
  }
}

async function signOut() {
 const usernameInput = document.getElementById("modal_email");
const passwordInput = document.getElementById("modal_password");

try {
  // Send a request to the backend to terminate the SSH session
  const response = await fetch("/ssh-sign-out", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "exit" })
  });

  if (!response.ok) {
    throw new Error(`Server returned ${response.status}`);
  }

  const result = await response.json();
  console.log("Server response:", result);

  alert("Disconnected from CSCI server (SSH session closed).");

} catch (err) {
  console.error("Error signing out:", err);
  alert("Error signing out. See console for details.");
} finally {
  if (usernameInput) usernameInput.value = "";
  if (passwordInput) passwordInput.value = "";
}
}

document.addEventListener("DOMContentLoaded", function () {
  document.getElementById("judge0-csci-sign-in-btn").addEventListener("click", showSignInModal);

  // Prevent native form submission to keep credentials out of the URL
  document.getElementById("judge0-csci-sign-in-form").addEventListener("submit", function (e) {
    e.preventDefault();
    signIn(e);
  });

  document.getElementById("judge0-csci-modal-sign-in-btn").addEventListener("click", signIn);
  document.getElementById("judge0-csci-modal-sign-in-cancel-btn").addEventListener("click", hideSignInModal);
  document.getElementById("judge0-csci-sign-out-btn").addEventListener("click", signOut);

  });
  //updateSignInUI();


