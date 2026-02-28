// Archived conversations page logic.

async function unarchiveConversation(conversationId, btn) {
  btn.disabled = true;
  btn.textContent = "Unarchiving...";

  try {
    const response = await fetch(
      `/api/conversation/${conversationId}/unarchive`,
      {
        method: "POST",
      },
    );

    if (response.ok) {
      const item = btn.closest(".conversation-item");
      item.style.opacity = "0";
      item.style.transform = "translateX(20px)";
      item.style.transition = "all 0.3s ease";

      setTimeout(() => {
        item.remove();

        const badge = document.querySelector(".archived-badge");
        const remaining =
          document.querySelectorAll(".conversation-item").length;
        badge.textContent = `${remaining} archived`;

        if (remaining === 0) {
          document.getElementById("conversationList").innerHTML =
            '<div class="empty-state">No archived conversations.</div>';
        }
      }, 300);
    } else {
      btn.disabled = false;
      btn.textContent = "Unarchive";
      console.error("Failed to unarchive conversation");
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Unarchive";
    console.error("Failed to unarchive:", e);
  }
}
