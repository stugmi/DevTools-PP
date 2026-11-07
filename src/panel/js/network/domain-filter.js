// Network domain filter: the Domains button, the removable chip for the active domain and the
// searchable popover. The options come from requestDomainOptions() (network-table.js); the
// filter itself is state.requestFilters.domain, applied by requestMatchesFilters.
// Loaded after network-table.js and before main.js (which resets it from the Clear button).
"use strict";

window.DomainFilterPanel = (() => {
  const POPOVER_WIDTH = 320;
  const ALL_DOMAINS = "All domains";
  const button = el.requestDomainButton;
  const popover = el.requestDomainPopover;
  const search = el.requestDomainSearch;
  const list = el.requestDomainList;

  function isOpen() {
    return !popover.hidden;
  }

  // -- Button and chip --

  // Mirrors state.requestFilters.domain. While a domain is set the button turns accent and
  // names it, and the chip beside it removes it in one click.
  function refreshButton() {
    const domain = state.requestFilters.domain;
    button.classList.toggle("active", Boolean(domain));
    button.title = domain ? `Filtering to ${domain}` : "Filter by domain";
    button.setAttribute("aria-label", domain ? `Domains: ${domain}` : "Domains");
    // The chip next to the button names the active domain; the button only lights up.
    el.requestDomainLabel.textContent = "Domains";
    el.requestDomainChip.hidden = !domain;
    el.requestDomainChipName.textContent = domain;
    el.requestDomainChipName.title = domain;
  }

  function refresh() {
    refreshButton();
    if (isOpen()) renderList();
  }

  // Applies a domain ("" shows all). Used by the popover, the chip and the request menu.
  function setDomain(domain) {
    if (state.requestFilters.domain === domain) return;
    state.requestFilters.domain = domain;
    refresh();
    refreshNetwork();
  }

  // -- List --

  function optionElement({ host, label, count }) {
    const row = document.createElement("div");
    row.className = "request-domain-option";
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(host === state.requestFilters.domain));
    row.tabIndex = -1;
    row.dataset.host = host;
    const name = document.createElement("span");
    name.className = "request-domain-name";
    name.textContent = label ?? host;
    name.title = label ?? host;
    const total = document.createElement("span");
    total.className = "request-domain-count";
    total.textContent = String(count);
    row.append(name, total);
    return row;
  }

  function renderList() {
    const query = search.value.trim().toLowerCase();
    const selected = state.requestFilters.domain;
    const options = requestDomainOptions();
    const requests = options.reduce((sum, option) => sum + option.count, 0);
    // A selection that no longer matches any request stays listed so the UI matches the filter.
    if (selected && !options.some(({ host }) => host === selected)) {
      options.push({ host: selected, count: 0 });
      options.sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
    }
    const shown = options.filter(({ host }) => !query || host.toLowerCase().includes(query));
    const rows = [{ host: "", label: ALL_DOMAINS, count: requests }, ...shown].map(optionElement);
    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "request-domain-empty";
      empty.setAttribute("role", "presentation");
      empty.textContent = query ? "No matching domains" : "No domains captured yet";
      rows.push(empty);
    }
    list.replaceChildren(...rows);
  }

  function optionRows() {
    return [...list.querySelectorAll(".request-domain-option")];
  }

  // -- Open and close --

  function position() {
    const rect = button.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(rect.right - POPOVER_WIDTH, window.innerWidth - POPOVER_WIDTH - 8)
    );
    popover.style.left = `${left}px`;
    popover.style.top = `${rect.bottom + 4}px`;
    popover.style.maxHeight = `${Math.max(160, window.innerHeight - rect.bottom - 12)}px`;
  }

  function open() {
    if (isOpen()) return;
    search.value = "";
    popover.hidden = false;
    button.setAttribute("aria-expanded", "true");
    position();
    renderList();
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    search.focus();
  }

  // Returns false when it was already closed. Focus returns to the button unless the user
  // clicked somewhere else.
  function close(restoreFocus = true) {
    if (!isOpen()) return false;
    const hadFocus = popover.contains(document.activeElement);
    popover.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if ((restoreFocus || hadFocus) && button.isConnected) button.focus();
    return true;
  }

  function choose(host) {
    setDomain(host);
    close();
  }

  // -- Events --

  button.addEventListener("click", () => (isOpen() ? close() : open()));
  el.requestDomainChipClear.addEventListener("click", () => {
    setDomain("");
    button.focus();
  });
  search.addEventListener("input", renderList);
  list.addEventListener("click", (event) => {
    const row = event.target.closest(".request-domain-option");
    if (row) choose(row.dataset.host);
  });

  // Arrows move between the search box and the options, Enter or Space picks one, Tab closes.
  popover.addEventListener("keydown", (event) => {
    const rows = optionRows();
    const index = rows.indexOf(document.activeElement);
    const onSearch = document.activeElement === search;
    if (Keybinds.matches(event, "list.next")) {
      event.preventDefault();
      rows[Math.min(index + 1, rows.length - 1)]?.focus();
    } else if (Keybinds.matches(event, "list.previous")) {
      event.preventDefault();
      if (index > 0) rows[index - 1].focus();
      else search.focus();
    } else if (!onSearch && event.key === "Home") {
      event.preventDefault();
      rows[0]?.focus();
    } else if (!onSearch && event.key === "End") {
      event.preventDefault();
      rows.at(-1)?.focus();
    } else if (event.key === "Enter" && onSearch) {
      // Enter in the search box picks the first match; the "All domains" row is rows[0].
      event.preventDefault();
      if (search.value.trim() && rows.length > 1) choose(rows[1].dataset.host);
    } else if ((event.key === "Enter" || event.key === " ") && index !== -1) {
      event.preventDefault();
      choose(rows[index].dataset.host);
    } else if (event.key === "Tab") {
      event.preventDefault();
      close();
    } else if (
      index !== -1 &&
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      search.focus(); // typing from the list continues in the search box
    }
  });

  document.addEventListener("mousedown", (event) => {
    if (!isOpen() || !(event.target instanceof Node)) return;
    if (popover.contains(event.target) || button.contains(event.target)) return;
    close(false);
  });
  window.addEventListener("resize", () => {
    if (isOpen()) position();
  });
  window.addEventListener("blur", () => close(false));

  refreshButton();
  return { open, close, isOpen, refresh, setDomain };
})();
