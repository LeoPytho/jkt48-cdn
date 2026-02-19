function showToast(type, title, message, duration = 5000) {
    if (!type) return showToast("error", "Terjadi kesalahan", "Terjadi kesalahan pada toast!", 5000)

    const valid = ["success", "info", "error"]
    if (!valid.includes(type)) return showToast("error", "Terjadi kesalahan", "Terjadi kesalahan pada toast!", 5000)

    if (!title) return showToast("error", "Terjadi kesalahan", "Terjadi kesalahan pada toast!", 5000)
    if (!message) return showToast("error", "Terjadi kesalahan", "Terjadi kesalahan pada toast!", 5000)
    if (!duration) return showToast("error", "Terjadi kesalahan", "Terjadi kesalahan pada toast!", 5000)
    if (isNaN(duration)) return showToast("error", "Terjadi kesalahan", "Terjadi kesalahan pada toast!", 5000)

    const timestamp = Number(duration)
    if (timestamp < 2000) return showToast("info", "Terjadi kesalahan", "Terjadi kesalahan pada toast!", 5000)

    const toast_list = document.querySelectorAll('.toastify');
    if (toast_list.length >= 2) {
        toast_list[toast_list.length - 1].remove();
    }

    Toastify({
        duration: timestamp,
        gravity: "top",
        position: "center",
        close: false,
        escapeMarkup: false,
        style: {
            background: "#fff"
        },
        className: "d-flex justify-content-between align-items-center toastify-custom rounded-5 p-3",
        text: `
        <div class="d-flex" style="height: 100%;">
            <div class="d-flex align-items-center">
                <div class="d-flex justify-content-center align-items-center bg-solid-${type === "success" ? "success" : type === "info" ? "primary" : "danger"} text-white rounded-4 p-2">
                    <i class="bx ${type === "success" ? "bxs-check-circle" : type === "info" ? "bxs-info-circle" : "bxs-x-circle"}"></i>
                </div>
                <div class="ms-3 d-flex flex-column justify-content-center">
                    <div class="text-solid-theme fs-7 fw-semibold">${title}</div>
                    <div class="text-solid-theme fs-9">${message}</div>
                </div>
            </div>
        </div>
        <button type="button" class="btn btn-sm rounded-4 text-secondary ms-3" style="border: 1.5px solid var(--bs-gray-200);" onclick="this.closest('.toastify').remove()">Close</button>`
    }).showToast();
}