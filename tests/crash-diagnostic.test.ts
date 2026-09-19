import { describe, expect, it } from 'vitest';
import { detectModName, detectReason, prettifyModId } from '../src/main/crash-diagnostic';

/**
 * Test 2 — "The Oracle" attribution (crash-diagnostic.ts), synthetic logs.
 * All assertions encode the CURRENT implementation behaviour. The JDK-frame
 * cases assert the repaired semantics (oracle-fixes; was 现状如此，疑似 bug:
 * the package-walk loop used to start at depth 2, so whitelisted
 * single-segment roots like 'java' were never checked and java.lang.*
 * frames surfaced a bogus mod named "Lang").
 *
 * diagnoseLastCrash is intentionally NOT covered here: it is fs-bound
 * (readdir/stat/read over crash-reports/) and outside the prescribed
 * function list — recorded in 18-TRUST-REPAIR-LOG.md.
 */

describe('detectReason', () => {
  it('returns the Caused by line verbatim', () => {
    const head = [
      '---- Minecraft Crash Report ----',
      'java.lang.NullPointerException: boom',
      'Caused by: java.lang.IllegalStateException: Already tesselating!',
    ].join('\n');
    expect(detectReason(head)).toBe('java.lang.IllegalStateException: Already tesselating!');
  });

  it('Caused by: OutOfMemoryError maps to the OOM reason', () => {
    expect(detectReason('Caused by: java.lang.OutOfMemoryError: Metaspace')).toBe(
      'Out of memory (java.lang.OutOfMemoryError)',
    );
  });

  it('bare OutOfMemoryError without Caused by is detected', () => {
    const head = [
      'java.lang.OutOfMemoryError: Java heap space',
      '\tat net.minecraft.server.MinecraftServer.run(MinecraftServer.java:1)',
    ].join('\n');
    expect(detectReason(head)).toBe('Out of memory (java.lang.OutOfMemoryError)');
  });

  it('Mixin apply failed is detected when no Caused by exists', () => {
    const head = 'Description: Initializing game\nMixin apply failed: sodium.mixins.json:client.json';
    expect(detectReason(head)).toBe('Mixin apply failed');
  });

  it('Caused by wins over Mixin apply failed (priority order)', () => {
    const head = [
      'Mixin apply failed: sodium.mixins.json',
      'Caused by: java.lang.IllegalStateException: x',
    ].join('\n');
    expect(detectReason(head)).toBe('java.lang.IllegalStateException: x');
  });

  it('truncates long Caused by lines to 200 chars + ellipsis', () => {
    expect(detectReason(`Caused by: ${'x'.repeat(250)}`)).toBe('x'.repeat(200) + '…');
  });

  it('no known signature → null', () => {
    expect(detectReason('Description: Something else entirely')).toBeNull();
  });
});

describe('detectModName', () => {
  it('maps a mixins config name back to the mod', () => {
    const head = 'Mixin apply failed: sodium.mixins.json:client.json (sodium.mixins.json)';
    expect(detectModName(head)).toBe('Sodium');
  });

  it('attributes a Mod file jar and strips the version tail', () => {
    expect(detectModName('Mod file: sodium-0.5.3.jar')).toBe('Sodium');
  });

  it('ignores the minecraft jar (not a mod) and vanilla frames', () => {
    const head = [
      'File: minecraft-1.21.1.jar',
      '\tat net.minecraft.client.main.Main.main(Main.java:1)',
    ].join('\n');
    expect(detectModName(head)).toBeUndefined();
  });

  it('attributes a stack frame whose package belongs to a mod', () => {
    const head = [
      'java.lang.IllegalStateException: Already tesselating!',
      '\tat net.sodium.client.render.ChunkBuilder.rebuild(ChunkBuilder.java:77)',
      '\tat net.minecraft.client.main.Main.main(Main.java:1)',
    ].join('\n');
    expect(detectModName(head)).toBe('Sodium');
  });

  it('does not misattribute whitelisted vanilla/library frames', () => {
    const head = [
      'Description: Initializing game',
      '\tat net.minecraft.client.main.Main.main(Main.java:123)',
      '\tat com.mojang.blaze3d.systems.RenderSystem.flip(RenderSystem.java:88)',
      '\tat org.spongepowered.asm.mixin.transformer.MixinProcessor.applyMixins(MixinProcessor.java:1)',
      '\tat net.fabricmc.loader.impl.game.minecraft.Hooks.startClient(Hooks.java:1)',
    ].join('\n');
    expect(detectModName(head)).toBeUndefined();
  });

  it('mixin config signal wins over stack frames', () => {
    const head = [
      'Mixin apply failed: sodium.mixins.json',
      '\tat net.aphelion.core.Aphelion.init(Aphelion.java:1)',
    ].join('\n');
    // Frame-only attribution would yield 'Aphelion'; 'Sodium' proves the
    // earlier (more reliable) mixin signal won.
    expect(detectModName(head)).toBe('Sodium');
  });

  it('does not misattribute pure JDK frames (java.lang.*)', () => {
    // Fixed regression guard: NON_MOD_PACKAGES whitelists the single roots
    // 'java'/'sun'/'jdk', but the depth loop used to start at 2, so the
    // 1-segment roots were never checked and 'java.lang.Thread.run' was
    // misattributed as a mod named "Lang".
    const head = [
      'java.lang.OutOfMemoryError: Java heap space',
      '\tat java.lang.Thread.run(Thread.java:834)',
    ].join('\n');
    expect(detectModName(head)).toBeUndefined();
  });

  it('does not misattribute other single-root JDK/library frames (sun/jdk/javax)', () => {
    const heads = [
      ['java.net.SocketTimeoutException: Read timed out', '\tat sun.nio.ch.NioSocketImpl.read(NioSocketImpl.java:9)'].join('\n'),
      ['jdk.internal.misc.Unsafe.park', '\tat jdk.internal.misc.Unsafe.park(Unsafe.java:1)'].join('\n'),
      ['javax.crypto.BadPaddingException: Given final block not properly padded', '\tat javax.crypto.Cipher.doFinal(Cipher.java:1)'].join('\n'),
    ];
    for (const head of heads) {
      expect(detectModName(head)).toBeUndefined();
    }
  });
});

describe('prettifyModId', () => {
  it('capitalizes single words', () => {
    expect(prettifyModId('sodium')).toBe('Sodium');
  });

  it('splits on hyphens and underscores', () => {
    expect(prettifyModId('sodium-extra')).toBe('Sodium Extra');
    expect(prettifyModId('lithium_fabric')).toBe('Lithium Fabric');
    expect(prettifyModId('a--b__c')).toBe('A B C');
  });

  it('returns the input unchanged when nothing survives cleaning', () => {
    expect(prettifyModId('---')).toBe('---');
  });
});

describe('hostile inputs never throw (Oracle contract)', () => {
  it('empty input', () => {
    expect(detectReason('')).toBeNull();
    expect(detectModName('')).toBeUndefined();
  });

  it('very short input', () => {
    expect(detectReason('x')).toBeNull();
    expect(detectModName('x')).toBeUndefined();
  });

  it('binary garbage', () => {
    const garbage = '\x00\x01\x02\uFFFD\u0000garbage\u00FF\x01';
    expect(() => detectReason(garbage)).not.toThrow();
    expect(() => detectModName(garbage)).not.toThrow();
    expect(detectReason(garbage)).toBeNull();
    expect(detectModName(garbage)).toBeUndefined();
  });
});
