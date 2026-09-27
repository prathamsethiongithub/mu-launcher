    // ── World Shelf · data layer ───────────────────────────────────────
    // The canonical renderer read a fixed array of seven hardcover records.
    // The shelf now reads the SAME record shape, built from the worlds the
    // launcher hands over on postMessage. Because the shape is unchanged,
    // selection, markers, theming, shelf layout and motion all keep working
    // exactly as the canonical renderer wrote them.
    const ROMAN_NUMERALS = [
      "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X",
      "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX"
    ];

    // One warm palette for the whole shelf. The brief asks for a warm-lit
    // shelf, so the room no longer recolours per item — a world's accent
    // drives its card face and the room's rim light only.
    const WARM_PALETTE = {
      paper: "#12100e",
      paperDeep: "#0b0a09",
      paperPale: "#f4f1ea",
      ink: "#f4f1ea",
      inkSoft: "#9c958a",
      wall: "#171310",
      shelf: "#3a2118",
      shelfDark: "#1c0e0a",
      light: "#ffcf96",
      fill: "#9c958a"
    };

    // A restrained ring of hues — varied enough that cards read as distinct
    // objects, narrow enough that the shelf never turns into rainbow soup.
    const ACCENT_HUES = [18, 34, 46, 96, 150, 188, 214, 258, 292, 330];

    function toRoman(value) {
      return ROMAN_NUMERALS[value - 1] || String(value);
    }

    // Stable per-world accent. Reuses the renderer's own FNV-1a hash, so a
    // world keeps the same colour across launches with nothing stored.
    function accentFor(world) {
      if (world.accentColor) return world.accentColor;
      const seed = hashSeed(String(world.id ?? world.title ?? ""));
      const hue = ACCENT_HUES[seed % ACCENT_HUES.length];
      const lightness = 40 + ((seed >>> 8) % 3) * 5;
      return `hsl(${hue} 34% ${lightness}%)`;
    }

    function statusLabel(status) {
      if (status === "online") return "Online";
      if (status === "offline") return "Offline";
      return "No server";
    }

    // world → the record shape the canonical renderer already consumes.
    function worldToRecord(world, index) {
      const meta = world.metadata || {};
      const accent = accentFor(world);
      return {
        id: String(world.id),
        title: world.title || String(world.id),
        roman: toRoman(index + 1),

        // Card face geometry — 16:10, per the brief.
        width: 1.02,
        height: 1.02 * (10 / 16),
        depth: 0.026,

        color: accent,
        foil: accent,
        palette: WARM_PALETTE,

        // Fields the untouched HTML readout still reads.
        discipline: world.subtitle || "",
        note: meta.modSummary || world.subtitle || "",
        paletteLabel: statusLabel(world.serverStatus),

        // Detail-panel fields. The panel is retired, but the record stays
        // complete so nothing downstream can read a hole.
        deck: meta.deck || world.subtitle || "",
        binding: meta.version
          ? `Minecraft ${meta.version}${meta.loader ? ` · ${meta.loader}` : ""}`
          : "",
        format: typeof meta.ram === "number" ? `${meta.ram} GB allocated` : "",
        theme: statusLabel(world.serverStatus),
        motif: meta.lastPlayed || "",
        motifKey: "brackets",
        chapters: ["", "", ""],

        // The raw world, for the pinned card overlay.
        world
      };
    }

    let BOOKS = [];
