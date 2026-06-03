function showGuide(section) {
  document.querySelectorAll('.guidePanel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `guide-${section}`);
  });

  document.querySelectorAll('.guideNav button').forEach(btn => {
    btn.classList.toggle('active', btn.textContent.toLowerCase().includes(section));
  });

  window.scrollTo({ top: 0, behavior: 'smooth' });
}
