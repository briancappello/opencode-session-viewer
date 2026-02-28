// Archived sessions page logic.

async function unarchiveSession(sessionId, btn) {
  btn.disabled = true;
  btn.textContent = "Unarchiving...";

  try {
    const response = await fetch(`/api/session/${sessionId}/unarchive`, {
      method: "POST",
    });

    if (response.ok) {
      const item = btn.closest(".session-item");
      item.style.opacity = "0";
      item.style.transform = "translateX(20px)";
      item.style.transition = "all 0.3s ease";

      setTimeout(() => {
        item.remove();

        const badge = document.querySelector(".archived-badge");
        const remaining = document.querySelectorAll(".session-item").length;
        badge.textContent = `${remaining} archived`;

        if (remaining === 0) {
          document.getElementById("sessionList").innerHTML =
            '<div class="empty-state">No archived sessions.</div>';
        }
      }, 300);
    } else {
      btn.disabled = false;
      btn.textContent = "Unarchive";
      console.error("Failed to unarchive session");
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Unarchive";
    console.error("Failed to unarchive:", e);
  }
}
