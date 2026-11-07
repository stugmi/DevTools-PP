// Source filter popover: the Files toolbar button, its on/off switch, the include and exclude
// rule inputs with one-click shortcuts, and the grouping controls. State and matching live in
// core/source-filter-state.js and lib/source-filter.js; this file is only the UI.
// Loaded after keyboard.js and before main.js (which wires the status bar chip).
"use strict";

window.SourceFilterPanel = (() => {
  const POPOVER_WIDTH = 380;
  const RULE_INPUT_DELAY_MS = 150;
  const MAX_DOMAIN_CHIPS = 6;
  // Exclude shortcuts: [label, rule].
  const EXCLUDE_SHORTCUTS = [
    ["node_modules", "node_modules"],
    ["Source maps", "*.map"],
    ["Minified", ".min.js"],
    ["Images", "type:image"],
    ["Fonts", "type:font"],
  ];

  const button = document.getElementById("btn-source-filter");
  const badge = document.getElementById("source-filter-badge");
  const popover = document.getElementById("source-filter-popover");
  const enabledInput = document.getElementById("sf-enabled");
  const enabledLabel = document.getElementById("sf-enabled-label");
  const includeInput = document.getElementById("sf-include");
  const excludeInput = document.getElementById("sf-exclude");
  const includeChips = document.getElementById("sf-include-chips");
  const excludeChips = document.getElementById("sf-exclude-chips");
  const includeError = document.getElementById("sf-include-error");
  const excludeError = document.getElementById("sf-exclude-error");
  const summary = document.getElementById("sf-summary");
  const groupSelect = document.getElementById("sf-group-by");
  const nestInput = document.getElementById("sf-nest");

  for (const { value, label } of SOURCE_GROUP_OPTIONS) groupSelect.add(new Option(label, value));

  function isOpen() {
    return !popover.hidden;
  }

  // -- Toolbar button --

  function refreshButton() {
    const filter = state.sourceFilter;
    button.classList.toggle("active", filter.active);
    button.classList.toggle("paused", filter.ruleCount > 0 && !filter.enabled);
    button.classList.toggle("error", filter.enabled && filter.hasErrors && !filter.active);
    badge.hidden = filter.ruleCount === 0;
    badge.textContent = String(filter.ruleCount);
    let title = "Filter files by type, domain or folder";
    if (filter.active) title = `Source filter on: ${filter.ruleCount} rule(s)`;
    else if (filter.ruleCount > 0 && !filter.enabled) title = "Source filter paused";
    button.title = title;
  }

  // -- Popover content --

  function previewCounts(filter) {
    const counts = { shown: 0, total: 0, types: new Map(), domains: new Map() };
    for (const section of ["mapped", "raw"]) {
      const tree = treeFor(section);
      for (const path in tree) {
        const entry = tree[path];
        const target = sourceFilterTarget(path, entry);
        counts.total++;
        if (filter.matches(target)) counts.shown++;
        counts.types.set(target.type, (counts.types.get(target.type) ?? 0) + 1);
        if (target.host)
          counts.domains.set(target.host, (counts.domains.get(target.host) ?? 0) + 1);
      }
    }
    return counts;
  }

  function renderChips(container, chips, input) {
    container.replaceChildren();
    for (const { label, rule, count } of chips) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "sf-chip";
      chip.textContent = count === undefined ? label : `${label} ${count}`;
      chip.title = rule;
      chip.setAttribute("aria-pressed", String(SourceFilter.hasToken(input.value, rule)));
      chip.addEventListener("click", () => {
        input.value = SourceFilter.toggleToken(input.value, rule);
        applyRules(input === includeInput ? "include" : "exclude");
        input.focus();
      });
      container.appendChild(chip);
    }
  }

  function showErrors(element, errors) {
    element.hidden = errors.length === 0;
    element.textContent = sourceFilterRuleStatus(errors);
  }

  function setFieldValue(input, value) {
    if (input.value !== value) input.value = value;
  }

  function refreshPopover() {
    const filter = state.sourceFilter;
    setFieldValue(includeInput, prefs.sourceFilterInclude);
    setFieldValue(excludeInput, prefs.sourceFilterExclude);
    enabledInput.checked = filter.enabled;
    enabledLabel.textContent = filter.enabled ? "On" : "Off";
    popover.classList.toggle("off", !filter.enabled);
    groupSelect.value = prefs.sourceGroupBy;
    nestInput.checked = prefs.sourceNestFolders;
    showErrors(includeError, filter.includeErrors);
    showErrors(excludeError, filter.excludeErrors);

    // What the rules would show, even while the filter is off.
    const counts = previewCounts(
      SourceFilter.createFilter({
        enabled: true,
        include: prefs.sourceFilterInclude,
        exclude: prefs.sourceFilterExclude,
      })
    );
    if (filter.ruleCount === 0) {
      summary.textContent = `No rules: showing all ${counts.total} files`;
    } else if (filter.enabled) {
      summary.textContent = `Showing ${counts.shown} of ${counts.total} files`;
    } else {
      summary.textContent = `Filter is off: showing all ${counts.total} files (rules would show ${counts.shown})`;
    }

    const typeChips = SourceFilter.FILE_TYPES.filter((type) => counts.types.has(type.id)).map(
      (type) => ({
        label: type.label,
        rule: `type:${type.id}`,
        count: counts.types.get(type.id),
      })
    );
    const domainChips = [...counts.domains]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_DOMAIN_CHIPS)
      .map(([host, count]) => ({ label: host, rule: `domain:${host}`, count }));
    renderChips(includeChips, [...typeChips, ...domainChips], includeInput);
    renderChips(
      excludeChips,
      EXCLUDE_SHORTCUTS.map(([label, rule]) => ({ label, rule })),
      excludeInput
    );
  }

  function refresh() {
    refreshButton();
    if (isOpen()) refreshPopover();
  }

  // -- Applying edits --

  let ruleTimer = null;

  // Rule edits turn the filter on: someone typing a rule wants to see its effect.
  function applyRules(which) {
    clearTimeout(ruleTimer);
    const input = which === "include" ? includeInput : excludeInput;
    setSourceFilter({ enabled: true, [which]: input.value });
  }

  function queueRules(which) {
    clearTimeout(ruleTimer);
    ruleTimer = setTimeout(() => applyRules(which), RULE_INPUT_DELAY_MS);
  }

  includeInput.addEventListener("input", () => queueRules("include"));
  excludeInput.addEventListener("input", () => queueRules("exclude"));
  enabledInput.addEventListener("change", () => setSourceFilter({ enabled: enabledInput.checked }));
  groupSelect.addEventListener("change", () => setSourceGrouping({ groupBy: groupSelect.value }));
  nestInput.addEventListener("change", () => setSourceGrouping({ nestFolders: nestInput.checked }));
  document.getElementById("sf-clear").addEventListener("click", () => {
    clearTimeout(ruleTimer);
    setSourceFilter({ include: "", exclude: "" });
    includeInput.focus();
  });
  document.getElementById("sf-settings").addEventListener("click", () => {
    close(false);
    window.EditorSettingsPanel.open("Source Filter");
  });

  // -- Open and close --

  function position() {
    const rect = button.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(rect.right - POPOVER_WIDTH, window.innerWidth - POPOVER_WIDTH - 8)
    );
    popover.style.left = `${left}px`;
    popover.style.top = `${rect.bottom + 4}px`;
    popover.style.maxHeight = `${Math.max(200, window.innerHeight - rect.bottom - 12)}px`;
  }

  function open() {
    if (isOpen()) return;
    // The button lives in the Files toolbar; the status bar chip can open this from Network.
    if (state.workspace !== "files") switchWorkspace("files");
    popover.hidden = false;
    button.setAttribute("aria-expanded", "true");
    position();
    refreshPopover();
    includeInput.focus();
  }

  function close(restoreFocus = true) {
    if (!isOpen()) return false;
    clearTimeout(ruleTimer);
    popover.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (restoreFocus && popover.contains(document.activeElement)) button.focus();
    return true;
  }

  function toggle() {
    if (isOpen()) close();
    else open();
  }

  button.addEventListener("click", toggle);
  window.addEventListener("resize", () => {
    if (isOpen()) position();
  });
  document.addEventListener("mousedown", (event) => {
    if (!isOpen() || !(event.target instanceof Node)) return;
    if (popover.contains(event.target) || button.contains(event.target)) return;
    if (el.statusFilter.contains(event.target)) return;
    close(false);
  });

  return { open, close, toggle, isOpen, refresh };
})();
