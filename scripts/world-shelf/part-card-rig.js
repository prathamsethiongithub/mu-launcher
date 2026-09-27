    // ── World Shelf · card rig ─────────────────────────────────────────
    // Replaces the hardcover book object with a 16:10 card. It returns the
    // exact shape createBookRig returned, so shelf layout, motion, fading,
    // hover raycasting and the tilt/select behaviour stay untouched.
    function makeCardCoverTexture(record) {
      const width = 640;
      const height = 400;
      const surface = document.createElement("canvas");
      surface.width = width;
      surface.height = height;
      const context = surface.getContext("2d");
      const accent = new THREE.Color(record.color);
      const deep = accent.clone().multiplyScalar(0.42);

      // Flat accent face with a soft vertical fall-off. No invented art:
      // the brief's cover image has no source in this launcher, so the card
      // is honest about being a colour field rather than a fake screenshot.
      const gradient = context.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, `#${accent.getHexString()}`);
      gradient.addColorStop(1, `#${deep.getHexString()}`);
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);

      // A quiet inner rule, the way the canonical covers framed their type.
      context.strokeStyle = "rgba(244, 238, 230, 0.26)";
      context.lineWidth = 2;
      context.strokeRect(18, 18, width - 36, height - 36);

      context.textAlign = "left";
      context.textBaseline = "alphabetic";

      context.fillStyle = "rgba(246, 241, 232, 0.55)";
      context.font = "500 22px 'Segoe UI', system-ui, sans-serif";
      context.fillText(`World ${record.roman}`, 44, 76);

      const title = record.title.length > 30
        ? `${record.title.slice(0, 29)}…`
        : record.title;
      context.fillStyle = "#f6f1e8";
      context.font = "600 60px 'Iowan Old Style', Baskerville, 'Times New Roman', serif";
      context.fillText(title, 44, height - 116, width - 88);

      if (record.note) {
        const note = record.note.length > 46
          ? `${record.note.slice(0, 45)}…`
          : record.note;
        context.fillStyle = "rgba(246, 241, 232, 0.72)";
        context.font = "400 26px 'Segoe UI', system-ui, sans-serif";
        context.fillText(note, 44, height - 66, width - 88);
      }

      const texture = new THREE.CanvasTexture(surface);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 4;
      return texture;
    }

    function createCardRig(record, index) {
      const root = new THREE.Group();
      root.name = `card-${record.id}`;
      root.userData.index = index;

      const motion = new THREE.Group();
      motion.name = `${record.id}-motion`;
      root.add(motion);

      // The pivot sits on the card's bottom edge, so rotating it tips the
      // card forward toward the camera — the shelf's "pick up" motion.
      const frontPivot = new THREE.Group();
      frontPivot.name = `${record.id}-pivot`;
      frontPivot.position.y = -record.height * 0.5;
      motion.add(frontPivot);

      const frame = new THREE.Group();
      frame.name = `${record.id}-frame`;
      frame.position.y = record.height * 0.5;
      frontPivot.add(frame);

      const radius = 0.022;

      // The slab's edges are the world's accent — the card's "spine".
      const edgeMaterial = createFadeMaterial(new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(record.color),
        roughness: 0.6,
        metalness: 0.05,
        clearcoat: 0.3,
        clearcoatRoughness: 0.5
      }));
      const faceMaterial = createFadeMaterial(new THREE.MeshPhysicalMaterial({
        map: makeCardCoverTexture(record),
        roughness: 0.88,
        metalness: 0,
        clearcoat: 0.14,
        clearcoatRoughness: 0.6
      }));

      // RoundedBoxGeometry carries one material group, so the cover is a
      // separate rounded plane laid just proud of the slab's front face.
      const body = createMesh(
        new RoundedBoxGeometry(record.width, record.height, record.depth, 4, radius * 0.5),
        edgeMaterial,
        `${record.id}-card-body`
      );
      frame.add(body);

      const face = createMesh(
        createRoundedPlaneGeometry(record.width - 0.024, record.height - 0.024, radius * 0.7),
        faceMaterial,
        `${record.id}-card-face`,
        false,
        true
      );
      face.position.z = record.depth * 0.5 + 0.0014;
      frame.add(face);

      // Hit target — wider than the card so pointer and touch both land.
      const hitMaterial = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false
      });
      const hit = createMesh(shared.box, hitMaterial, `${record.id}-hit-target`, false, false);
      hit.scale.set(record.width * 1.34, record.height * 1.4, Math.max(record.depth * 6, 1));
      hit.position.set(0, 0, 0.1);
      hit.userData.index = index;
      frame.add(hit);
      hitTargets.push(hit);

      const contactShadowMaterial = new THREE.MeshBasicMaterial({
        color: new THREE.Color(record.palette.shelfDark),
        alphaMap: makeContactShadowTexture(),
        transparent: true,
        opacity: 0.24,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      const contactShadow = createMesh(
        shared.plane,
        contactShadowMaterial,
        `${record.id}-contact-shadow`,
        false,
        false
      );
      contactShadow.scale.set(record.width * 1.06, record.depth * 5.5, 1);
      contactShadow.rotation.x = -Math.PI * 0.5;
      contactShadow.position.set(0, -record.height * 0.5 - 0.02, 0.03);
      root.add(contactShadow);

      const fadeMaterials = [edgeMaterial, faceMaterial];

      return {
        data: record,
        root,
        motion,
        frontPivot,
        cardAnchor: frontPivot,
        frontCover: face,
        pageBlock: null,
        pagePivots: [],
        pageSurfaces: [],
        pageGestureSurfaces: [],
        hit,
        coverTexture: faceMaterial.map,
        contactShadow,
        base: {
          width: record.width,
          height: record.height,
          depth: record.depth
        },
        opacity: 1,
        lastOffset: null,
        fadeMaterials,
        materials: fadeMaterials
      };
    }
