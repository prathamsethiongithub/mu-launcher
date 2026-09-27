    // ── World Shelf · host bridge ──────────────────────────────────────
    // Mounted inside the iframe by the launcher. Worlds, the play request
    // and the selected card all cross this boundary; nothing else does.
    // The shelf's scene, lighting, layout and motion stay canonical.
    const shelfCount = document.querySelector("#shelf-count");
    const fallbackList = document.querySelector("#fallback-list");
    const overlay = document.querySelector("#card-overlay");
    const overlayTitle = document.querySelector("#card-overlay-title");
    const overlaySubtitle = document.querySelector("#card-overlay-subtitle");
    const overlayStatus = document.querySelector("#card-overlay-status");
    const overlayPlay = document.querySelector("#card-overlay-play");
    const hitPoint = { x: 0, y: 0 };

    const SHARED_GEOMETRIES = new Set([shared.box, shared.plane]);
    const overlayState = {
      running: false,
      hostPaused: false,
      record: null
    };

    function postToHost(payload) {
      try {
        (window.parent || window).postMessage(payload, "*");
      } catch (error) {
        // A missing host is not a failure: the shelf stays browsable.
      }
    }

    // The card rig borrows the two shared geometries; everything else it
    // created belongs to it and is released here.
    function disposeRig(rig) {
      rig.root.traverse((child) => {
        if (child.geometry && !SHARED_GEOMETRIES.has(child.geometry)) {
          child.geometry.dispose();
        }
        if (!child.material) return;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((material) => {
          if (material.map && !SHARED_GEOMETRIES.has(material.map)) material.map.dispose();
          material.dispose();
        });
      });
    }

    function statusLegend(record) {
      const meta = (record.world && record.world.metadata) || {};
      if (meta.server) return `Server · ${meta.server}`;
      return record.paletteLabel;
    }

    // The static fallback is the shelf's no-WebGL path, so it lists the same
    // worlds as plain rows rather than showing an empty catalog.
    function renderFallbackList(worlds) {
      if (!fallbackList) return;
      fallbackList.replaceChildren();
      (worlds || []).forEach((world) => {
        const item = document.createElement("li");
        item.className = "fallback-world";
        item.dataset.server = world.serverStatus || "none";
        const title = document.createElement("strong");
        title.textContent = world.title || String(world.id);
        const note = document.createElement("span");
        note.textContent = world.subtitle || "";
        item.append(title, note);
        fallbackList.append(item);
      });
    }

    function applyOverlayRecord(record) {
      if (!overlay || !record) return;
      overlayState.record = record;
      overlayTitle.textContent = record.title;
      overlaySubtitle.textContent = record.note || "";
      overlayStatus.textContent = statusLegend(record);
      overlay.dataset.server = (record.world && record.world.serverStatus) || "none";
      // The worlds payload carries isActive; the selected card is where the
      // user actually sees which world the launcher will launch.
      overlay.dataset.active = String(Boolean(record.world && record.world.isActive));
      overlayPlay.dataset.worldId = record.id;
    }

    // Keep the play control sitting just above the selected card as the
    // camera moves, which is what makes it read as part of the card.
    function syncOverlay() {
      if (!overlay || !overlayState.running) return;
      const rig = bookRigs[selectedIndex];
      if (!rig || !rig.frontCover || !camera) {
        overlay.dataset.visible = "false";
        return;
      }

      const top = new THREE.Vector3(0, rig.base.height * 0.5, 0);
      const bottom = new THREE.Vector3(0, -rig.base.height * 0.5, 0);
      rig.frontCover.localToWorld(top);
      rig.frontCover.localToWorld(bottom);
      top.project(camera);
      bottom.project(camera);

      if (top.z > 1 || bottom.z > 1) {
        overlay.dataset.visible = "false";
        return;
      }

      const bounds = canvas.getBoundingClientRect();
      const centerX = bounds.left + ((top.x + bottom.x) * 0.5 * 0.5 + 0.5) * bounds.width;
      const topY = bounds.top + (top.y * 0.5 + 0.5) * bounds.height;
      const cardPixels = Math.abs(bottom.y - top.y) * bounds.height;

      // A collapsed frame (or a camera mid-resize) can produce a degenerate
      // projection. Never let that reach the stylesheet as NaN.
      if (!Number.isFinite(centerX) || !Number.isFinite(topY)) {
        overlay.dataset.visible = "false";
        return;
      }

      overlay.style.setProperty("--anchor-x", `${centerX}px`);
      overlay.style.setProperty("--anchor-y", `${topY}px`);
      overlay.style.setProperty("--card-scale", String(Math.min(Math.max(cardPixels / 320, 0.72), 1.25)));
      overlay.dataset.visible = cardPixels > 60 ? "true" : "false";
    }

    function overlayLoop() {
      overlayState.running = true;
      const step = () => {
        if (!overlayState.running) return;
        // Worlds can arrive before the renderer does; they wait here until
        // the shelf is ready to build them.
        if (overlayState.pendingWorlds && renderer) flushPendingWorlds();
        if (!overlayState.hostPaused) syncOverlay();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }

    // Rebuild the shelf in place from a fresh list of worlds. This reuses
    // the canonical marker/selection machinery, so the index rail, counter
    // and keyboard navigation keep working with no changes.
    function buildShelfFromWorlds(worlds) {
      const records = (worlds || [])
        .filter((world) => world && world.id != null)
        .map((world, index) => worldToRecord(world, index));

      if (!records.length) {
        showFallback("No worlds yet. Create one and it will appear on this shelf.");
        return;
      }

      BOOKS = records;

      bookRigs.forEach((rig) => {
        shelfStage.remove(rig.root);
        disposeRig(rig);
      });
      bookRigs = [];
      hitTargets.length = 0;
      markers.replaceChildren();

      bookRigs = BOOKS.map((record, index) => {
        const rig = createCardRig(record, index);
        shelfStage.add(rig.root);
        return rig;
      });

      buildMarkers();
      selectedIndex = 0;
      updateSelection(0, true);

      // Relabel the index rail for worlds rather than volumes.
      [...markers.children].forEach((marker, index) => {
        marker.setAttribute("aria-label", `Select world ${index + 1}: ${BOOKS[index].title}`);
      });
      if (shelfCount) {
        shelfCount.textContent = `${BOOKS.length} ${BOOKS.length === 1 ? "world" : "worlds"}`;
      }

      staticFallback.hidden = true;
      loading.hidden = true;
      experience.classList.add("webgl-ready");
      lastTime = performance.now();
      requestFrame();
    }

    function hostPause() {
      overlayState.hostPaused = true;
      suspended = true;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    }

    function hostResume() {
      overlayState.hostPaused = false;
      suspended = false;
      lastTime = performance.now();
      requestFrame();
    }

    // ── retire the book-only reading flow ──────────────────────────────
    // Opening a hardcover revealed a page spread. A card has no pages, so
    // the entry points are closed off and the card's own select-and-tilt
    // motion becomes the entire interaction.
    openDetail = () => {};
    closeDetail = () => {};
    setReadingOpen = () => {};
    turnPage = () => {};
    resetInspectionView = () => {};

    // ── selection → host ──────────────────────────────────────────────
    const canonicalUpdateSelection = updateSelection;
    updateSelection = function (index, announce = false) {
      canonicalUpdateSelection(index, announce);
      const record = BOOKS[selectedIndex];
      if (!record) return;
      applyOverlayRecord(record);
      syncOverlay();
      postToHost({ type: "world-selected", worldId: record.id });
    };

    function requestPlay(worldId) {
      if (!worldId) return;
      postToHost({ type: "play-requested", worldId });
    }

    overlayPlay.addEventListener("click", () => {
      requestPlay(overlayPlay.dataset.worldId);
    });

    // The bottom bar's primary button was "Open volume" and opened the page
    // spread. It now launches the selected world.
    inspectButton.addEventListener("click", () => {
      const record = BOOKS[selectedIndex];
      if (record) requestPlay(record.id);
    });

    window.addEventListener("message", (event) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;

      if (data.type === "worlds") {
        const worlds = data.worlds || [];
        renderFallbackList(worlds);
        overlayState.pendingWorlds = worlds;
        if (renderer) flushPendingWorlds();
        return;
      }
      if (data.type === "pause") {
        hostPause();
        return;
      }
      if (data.type === "resume") {
        hostResume();
      }
    });

    function flushPendingWorlds() {
      const pending = overlayState.pendingWorlds;
      if (!pending) return;
      overlayState.pendingWorlds = null;
      buildShelfFromWorlds(pending);
    }

    overlayLoop();
    postToHost({ type: "shelf-ready" });

    // Exposed for the launcher's own smoke checks and for manual poking.
    window.__worldShelf = {
      build: buildShelfFromWorlds,
      pause: hostPause,
      resume: hostResume,
      get worlds() {
        return BOOKS;
      },
      // Anchor geometry, for the launcher's smoke checks.
      debug() {
        const rig = bookRigs[selectedIndex];
        const probe = new THREE.Vector3(0, rig ? rig.base.height * 0.5 : 0, 0);
        if (rig && rig.frontCover) rig.frontCover.localToWorld(probe);
        const projected = probe.clone().project(camera);
        const bounds = canvas.getBoundingClientRect();
        return {
          running: overlayState.running,
          hostPaused: overlayState.hostPaused,
          selectedIndex,
          bookCount: BOOKS.length,
          rigCount: bookRigs.length,
          hasRig: !!rig,
          hasCover: !!(rig && rig.frontCover),
          hasCamera: !!camera,
          bounds: { width: bounds.width, height: bounds.height, top: bounds.top },
          projected: projected.toArray(),
          visible: overlay ? overlay.dataset.visible : null
        };
      }
    };
