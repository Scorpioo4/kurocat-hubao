import idleUrl from './assets/hubao_sticker/sticker_idle.png';
import grumpyUrl from './assets/hubao_sticker/sticker_grumpy.png';
import happyUrl from './assets/hubao_sticker/sticker_happy.png';
import surprisedUrl from './assets/hubao_sticker/sticker_surprised.png';
import sighUrl from './assets/hubao_sticker/fx_sigh.png';
import heartUrl from './assets/hubao_sticker/fx_heart.png';
import starUrl from './assets/hubao_sticker/fx_star.png';
import type { DaFeiYuLayout } from './dafeiyuRenderer';

interface PawState {
  x: number;
  y: number;
  tx: number;
  ty: number;
  lastAt: number;
  squash: number;
  heldVks: Set<number>;
}

interface TapRipple {
  x: number;
  y: number;
  r: number;
  life: number;
}

interface StickerParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  scale: number;
  rot: number;
  vrot: number;
  kind: 'sigh' | 'heart' | 'star';
}

type HubaoMood = 'idle' | 'grumpy' | 'happy' | 'surprised';

const SPRITE_META: Record<HubaoMood, { w65: number; h65: number; w108: number; h108: number; yOff: number }> = {
  // 267x322 sitting Hubao
  idle: { w65: 216, h65: 260, w108: 224, h108: 270, yOff: 12 },
  // 322x254 lying-down grumpy Hubao resting right behind the keyboard!
  grumpy: { w65: 272, h65: 215, w108: 284, h108: 224, yOff: 6 },
  // 313x306 cheering raised-paws happy Hubao (bottom sits flush behind keyboard top edge)
  happy: { w65: 256, h65: 250, w108: 266, h108: 260, yOff: 12 },
  // 264x300 surprised Hubao for privacy eye-covering mode (bottom sits flush behind keyboard top edge)
  surprised: { w65: 224, h65: 254, w108: 232, h108: 264, yOff: 12 },
};

/**
 * Hand-drawn Sticker Hubao 2.0 companion renderer for KuroCat.
 * Uses the user's own hand-drawn Hubao sticker artwork directly:
 * - Idle: cute sitting Hubao (sticker #2)
 * - Typing / working: switches to grumpy pouting lying-down Hubao (sticker #4) with animated
 *   thick-brown-outline white paws pounding the keyboard + floating original blue sigh puffs!
 * - Petting: switches to joyful laughing raised-paws Hubao (sticker #3) with purring + original
 *   hand-drawn pink hearts & yellow sparkles!
 * - Password privacy: surprised Hubao (sticker #1) covering eyes with both thick-outline white paws!
 */
export class HubaoRenderer {
  private sprites: Record<HubaoMood, HTMLImageElement>;
  private fx: Record<'sigh' | 'heart' | 'star', HTMLImageElement>;

  private lastKeyAt = -10000;
  private grumpyUntil = -10000;
  private lastSighAt = -10000;
  private keyTimes: number[] = [];
  private typingHeat = 0;

  private bodyShiftX = 0;
  private bodyShiftVel = 0;
  private bodyShiftTarget = 0;
  private bodyTilt = 0;
  private bodyTiltVel = 0;
  private bodyTiltTarget = 0;
  private bodyDiveY = 0;
  private bodyBob = 0;

  private leftHand: PawState = {
    x: 150,
    y: 325,
    tx: 150,
    ty: 325,
    lastAt: -10000,
    squash: 0,
    heldVks: new Set(),
  };
  private rightHand: PawState = {
    x: 242,
    y: 325,
    tx: 242,
    ty: 325,
    lastAt: -10000,
    squash: 0,
    heldVks: new Set(),
  };

  private tail = {
    relX: 82,
    relY: -30,
    activeWag: 0,
    slapAt: -10000,
    releaseAt: -10000,
    slapTargetX: 340,
    slapTargetY: 355,
    heldVks: new Set<number>(),
    squash: 0,
    phase: 0,
  };

  private ripples: TapRipple[] = [];
  private particles: StickerParticle[] = [];

  constructor() {
    const mk = (src: string) => {
      const img = new Image();
      img.src = src;
      return img;
    };
    this.sprites = {
      idle: mk(idleUrl),
      grumpy: mk(grumpyUrl),
      happy: mk(happyUrl),
      surprised: mk(surprisedUrl),
    };
    this.fx = {
      sigh: mk(sighUrl),
      heart: mk(heartUrl),
      star: mk(starUrl),
    };
  }

  public onPrivacyModeChanged(active: boolean): void {
    if (active) {
      this.leftHand.heldVks.clear();
      this.rightHand.heldVks.clear();
      this.tail.heldVks.clear();
      this.ripples.length = 0;
    }
  }

  public onPrivacyTyping(): void {
    this.bodyBob = Math.min(0.65, this.bodyBob + 0.42);
  }

  public resetLeftHandForMouse(): void {
    this.leftHand.lastAt = -10000;
  }

  public onMouseAction(_now: number = performance.now()): void {
    // Kept for interface parity
  }

  public getHandBusyState(now: number): { leftHeld: number; rightHeld: number; rightBusy: boolean } {
    const leftHeld = this.leftHand.heldVks.size;
    const rightHeld = this.rightHand.heldVks.size;
    const rightBusy = rightHeld > 0 || now - this.rightHand.lastAt < 135;
    return { leftHeld, rightHeld, rightBusy };
  }

  public triggerTailPreview(pt: { x: number; y: number }, layout: DaFeiYuLayout): void {
    if (layout.privacyMode) return;
    const now = performance.now();
    this.grumpyUntil = Math.max(this.grumpyUntil, now + 1500);
    this.tail.slapAt = now;
    this.tail.releaseAt = now + 220;
    this.tail.slapTargetX = pt.x;
    this.tail.slapTargetY = pt.y;
    this.tail.squash = 1;
    this.bodyBob = Math.min(1.0, this.bodyBob + 0.6);
    const normX = Math.max(-1, Math.min(1, (pt.x - layout.kbCenterX) / (layout.kbWidth * 0.46)));
    this.bodyTiltTarget = normX * 0.065;
    this.bodyShiftTarget = normX * 8;
    this.ripples.push({ x: pt.x, y: pt.y, r: 5, life: 1 });
    this.spawnSighPuff(layout, now, true);
  }

  public onKeyDown(
    vk: number,
    pt: { x: number; y: number },
    layout: DaFeiYuLayout,
    repeat: boolean,
    useTail: boolean,
  ): void {
    if (layout.privacyMode || repeat) return;
    const now = performance.now();
    const wasIdle = now > this.grumpyUntil;
    this.lastKeyAt = now;
    this.grumpyUntil = now + 1550; // Stay pouting/grumpy while working on keyboard!
    this.keyTimes.push(now);
    this.bodyBob = Math.min(1.15, this.bodyBob + 0.78);

    // Pop a grumpy blue sigh cloud right when forced to start typing, and periodically while typing fast!
    if (wasIdle || now - this.lastSighAt > Math.max(680, 1550 - this.typingHeat * 850)) {
      this.spawnSighPuff(layout, now, false);
    }

    const charX = layout.is108 ? 268 : 196;
    const normX = Math.max(-1, Math.min(1, (pt.x - layout.kbCenterX) / (layout.kbWidth * 0.46)));
    const mouseBusy = layout.mouseLeft || layout.mouseRight || now - layout.mouseActiveAt < 900;
    const isLeftSide = pt.x < layout.kbCenterX - 2;

    if (useTail) {
      this.tail.slapAt = now;
      this.tail.releaseAt = -10000;
      this.tail.heldVks.add(vk);
      this.tail.slapTargetX = pt.x;
      this.tail.slapTargetY = pt.y;
      this.tail.squash = 1;
      if (!mouseBusy) {
        this.bodyTiltTarget = normX >= 0 ? -0.075 : 0.055;
        this.bodyShiftTarget = normX >= 0 ? -7 : 8;
      }
      this.ripples.push({ x: pt.x, y: pt.y, r: 5, life: 1 });
    } else if (mouseBusy) {
      const shiftBase = layout.is108 ? -86 : -34;
      const curCharX = charX + shiftBase;
      const comfortX = Math.max(curCharX - 10, Math.min(curCharX + 94, pt.x));
      const comfortY = Math.min(layout.kbCenterY + 6, pt.y);
      this.rightHand.tx = comfortX;
      this.rightHand.ty = comfortY;
      this.rightHand.lastAt = now;
      this.rightHand.squash = 1;
      this.rightHand.heldVks.add(vk);
    } else {
      this.bodyTiltTarget = normX * 0.085;
      this.bodyShiftTarget = normX * (layout.is108 ? 20 : 12);
      const comfortX =
        charX +
        this.bodyShiftTarget +
        Math.max(-78, Math.min(78, (pt.x - charX) * 0.80));
      const comfortY = Math.min(layout.kbCenterY + 10, pt.y);
      if (isLeftSide) {
        this.leftHand.tx = comfortX;
        this.leftHand.ty = comfortY;
        this.leftHand.lastAt = now;
        this.leftHand.squash = 1;
        this.leftHand.heldVks.add(vk);
      } else {
        this.rightHand.tx = comfortX;
        this.rightHand.ty = comfortY;
        this.rightHand.lastAt = now;
        this.rightHand.squash = 1;
        this.rightHand.heldVks.add(vk);
      }
    }
  }

  public onKeyUp(vk: number): void {
    const now = performance.now();
    this.leftHand.heldVks.delete(vk);
    this.rightHand.heldVks.delete(vk);
    if (this.tail.heldVks.has(vk)) {
      this.tail.heldVks.delete(vk);
      if (this.tail.heldVks.size === 0) {
        this.tail.releaseAt = now;
      }
    }
  }

  private spawnSighPuff(layout: DaFeiYuLayout, now: number, force: boolean): void {
    if (!force && now - this.lastSighAt < 520) return;
    this.lastSighAt = now;
    const charX = (layout.is108 ? 268 : 196) + this.bodyShiftX;
    this.particles.push({
      x: charX - 8 + (Math.random() - 0.5) * 38,
      y: 138 + (Math.random() - 0.5) * 14,
      vx: (Math.random() - 0.5) * 0.55,
      vy: -0.95 - Math.random() * 0.55,
      life: 1,
      scale: 0.76 + Math.random() * 0.24,
      rot: (Math.random() - 0.5) * 0.28,
      vrot: (Math.random() - 0.5) * 0.015,
      kind: 'sigh',
    });
  }

  private spawnJoyParticle(x: number, y: number): void {
    const isHeart = Math.random() > 0.42;
    this.particles.push({
      x: x + (Math.random() - 0.5) * 90,
      y: y + (Math.random() - 0.5) * 26,
      vx: (Math.random() - 0.5) * 0.75,
      vy: -1.0 - Math.random() * 0.9,
      life: 1,
      scale: isHeart ? 0.72 + Math.random() * 0.26 : 0.68 + Math.random() * 0.28,
      rot: (Math.random() - 0.5) * 0.25,
      vrot: (Math.random() - 0.5) * 0.02,
      kind: isHeart ? 'heart' : 'star',
    });
  }

  private getCurrentMood(now: number, layout: DaFeiYuLayout): HubaoMood {
    if (layout.privacyMode) return 'surprised';
    if (layout.petEnergy > 0.25) return 'happy';
    const isWorking =
      now < this.grumpyUntil ||
      this.leftHand.heldVks.size > 0 ||
      this.rightHand.heldVks.size > 0 ||
      this.tail.heldVks.size > 0;
    if (isWorking) return 'grumpy';
    return 'idle';
  }

  public update(dt: number, now: number, layout: DaFeiYuLayout): void {
    this.bodyBob *= Math.exp(-12 * dt);

    const mood = this.getCurrentMood(now, layout);
    const isPetted = mood === 'happy';
    const isGrumpyTyping = mood === 'grumpy';
    const isTypingActive =
      !layout.privacyMode &&
      (now - this.lastKeyAt < 550 ||
        this.tail.heldVks.size > 0 ||
        this.leftHand.heldVks.size > 0 ||
        this.rightHand.heldVks.size > 0);
    const mouseMode =
      !layout.privacyMode &&
      !isPetted &&
      (layout.mouseLeft || layout.mouseRight || now - layout.mouseActiveAt < 900);

    while (this.keyTimes.length && now - this.keyTimes[0] > 2600) {
      this.keyTimes.shift();
    }
    const typingCPS = this.keyTimes.length / 2.6;
    const heatTarget = layout.privacyMode
      ? 0
      : Math.min(1, Math.max(0, (typingCPS - 1.5) / 4.5));
    if (heatTarget > this.typingHeat) {
      this.typingHeat += (heatTarget - this.typingHeat) * (1 - Math.exp(-2.8 * dt));
    } else {
      this.typingHeat += (heatTarget - this.typingHeat) * (1 - Math.exp(-0.9 * dt));
    }

    const charX = layout.is108 ? 268 : 196;
    if (isPetted && Math.random() < 0.085) {
      this.spawnJoyParticle(charX + this.bodyShiftX, 118);
    }

    // Body spring physics
    if (layout.privacyMode) {
      this.bodyShiftTarget = 0;
      const shySway =
        Math.sin(now * 0.0045) * 0.035 +
        (now - layout.privacyTypingAt < 240 ? Math.sin(now * 0.04) * 0.025 : 0);
      this.bodyTiltTarget = shySway;
      this.bodyDiveY *= Math.exp(-9 * dt);
    } else if (isPetted) {
      this.bodyShiftTarget = 0;
      // Happy cheering side-to-side sway!
      this.bodyTiltTarget = Math.sin(now * 0.011) * 0.075;
      this.bodyDiveY *= Math.exp(-9 * dt);
    } else if (mouseMode) {
      const baseShift = layout.is108 ? -118 : -34;
      this.bodyShiftTarget = baseShift + (layout.mouseNX - 0.5) * 12;
      this.bodyTiltTarget = -0.085;
      this.bodyDiveY += (6 - this.bodyDiveY) * (1 - Math.exp(-10 * dt));
    } else if (!isTypingActive) {
      this.bodyShiftTarget = 0;
      // Subtle grumpy breathing grumble when still cooling down from typing
      this.bodyTiltTarget = isGrumpyTyping ? Math.sin(now * 0.007) * 0.022 : 0;
      this.bodyDiveY *= Math.exp(-9 * dt);
    } else {
      this.bodyDiveY *= Math.exp(-9 * dt);
    }

    const shiftAcc = (this.bodyShiftTarget - this.bodyShiftX) * 155 - this.bodyShiftVel * 18;
    this.bodyShiftVel += shiftAcc * dt;
    this.bodyShiftX += this.bodyShiftVel * dt;

    const tiltAcc = (this.bodyTiltTarget - this.bodyTilt) * 175 - this.bodyTiltVel * 17;
    this.bodyTiltVel += tiltAcc * dt;
    this.bodyTilt += this.bodyTiltVel * dt;

    // Slapping tail physics (shown cleanly whenever tail slaps a key!)
    const gTail = this.computeGeom(now, layout, mood);
    const tailRoot = gTail.spritePointToWorld(0.68, 0.72);
    const tailAge = Math.max(0, now - this.tail.slapAt);
    const holdingSlap =
      !layout.privacyMode &&
      (this.tail.heldVks.size > 0 || (this.tail.slapAt > 0 && tailAge < 250));
    let targetPhase = 0;
    if (holdingSlap) {
      targetPhase = Math.min(1, tailAge / 65);
    } else if (!layout.privacyMode && this.tail.slapAt > 0) {
      const holdEnd = Math.max(this.tail.slapAt + 250, this.tail.releaseAt);
      const retElapsed = Math.max(0, now - holdEnd);
      targetPhase = Math.max(0, 1 - retElapsed / 220);
    }
    this.tail.phase += (targetPhase - this.tail.phase) * (1 - Math.exp(-34 * dt));
    if (this.tail.phase < 0.002 && targetPhase === 0) this.tail.phase = 0;

    const idleOffX = 68;
    const idleOffY = -36;
    const slapOffX = this.tail.slapTargetX - tailRoot.x;
    const slapOffY = this.tail.slapTargetY - tailRoot.y;
    const targetRelX = idleOffX + (slapOffX - idleOffX) * this.tail.phase;
    const targetRelY = idleOffY + (slapOffY - idleOffY) * this.tail.phase;
    const tLerp = 1 - Math.exp(-36 * dt);
    this.tail.relX += (targetRelX - this.tail.relX) * tLerp;
    this.tail.relY += (targetRelY - this.tail.relY) * tLerp;
    this.tail.squash *= Math.exp(-11 * dt);
    this.tail.activeWag = -0.06 * this.tail.phase;

    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const rp = this.ripples[i];
      rp.r += 54 * dt;
      rp.life -= 2.4 * dt;
      if (rp.life <= 0) this.ripples.splice(i, 1);
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vrot;
      p.life -= (p.kind === 'sigh' ? 0.017 : 0.020) * (dt * 60);
      if (p.life <= 0) this.particles.splice(i, 1);
    }
  }

  private computeGeom(now: number, layout: DaFeiYuLayout, mood: HubaoMood) {
    const meta = SPRITE_META[mood];
    const charX = layout.is108 ? 268 : 196;
    const kbTopEdge = layout.kbCenterY - layout.kbHeight * 0.34;
    const baseCharY = kbTopEdge + meta.yOff;
    const breath = Math.sin(now * 0.0036) * 2.0 + this.bodyBob * 3.8 + this.bodyDiveY;
    const charCenterX = charX + this.bodyShiftX;
    const charBaseY = baseCharY + breath;
    const drawW = layout.is108 ? meta.w108 : meta.w65;
    const drawH = layout.is108 ? meta.h108 : meta.h65;
    const pivotOff = 36;
    const pivotY = charBaseY - pivotOff;

    const spritePointToWorld = (normX: number, normY: number) => {
      const lx = (normX - 0.5) * drawW;
      const ly = normY * drawH - drawH + pivotOff;
      const c = Math.cos(this.bodyTilt);
      const s = Math.sin(this.bodyTilt);
      return {
        x: charCenterX + lx * c - ly * s,
        y: pivotY + lx * s + ly * c,
      };
    };

    return {
      charCenterX,
      charBaseY,
      drawW,
      drawH,
      pivotOff,
      pivotY,
      spritePointToWorld,
    };
  }

  /** Layer 1 (drawn BEFORE keyboard & mouse): original hand-drawn Hubao sticker sprite. */
  public renderBody(ctx: CanvasRenderingContext2D, now: number, layout: DaFeiYuLayout): void {
    const mood = this.getCurrentMood(now, layout);
    const g = this.computeGeom(now, layout, mood);
    const img = this.sprites[mood] || this.sprites.idle;

    if (img && img.complete && img.naturalWidth > 0) {
      ctx.save();
      // Clip smoothly right along the top edge of the keyboard so Hubao sits cozily behind it!
      ctx.beginPath();
      ctx.rect(0, 0, layout.logicalW, layout.kbCenterY - layout.kbHeight * 0.30);
      ctx.clip();
      ctx.translate(g.charCenterX, g.pivotY);
      ctx.rotate(this.bodyTilt);
      // Grumpy typing bounce squash-and-stretch!
      const sqX = 1 + this.bodyBob * 0.032;
      const sqY = 1 - this.bodyBob * 0.028;
      ctx.scale(sqX, sqY);
      ctx.drawImage(img, -g.drawW * 0.5, -g.drawH + g.pivotOff, g.drawW, g.drawH);
      ctx.restore();
    }
  }

  /** Layer 2 (drawn AFTER keyboard & mouse): thick-outline paws when typing/mousing/privacy, tail slap & sticker FX! */
  public renderForeground(
    ctx: CanvasRenderingContext2D,
    dt: number,
    now: number,
    layout: DaFeiYuLayout,
  ): void {
    const mood = this.getCurrentMood(now, layout);
    const g = this.computeGeom(now, layout, mood);

    const isPetted = mood === 'happy';
    const mouseMode =
      !layout.privacyMode &&
      !isPetted &&
      (layout.mouseLeft || layout.mouseRight || now - layout.mouseActiveAt < 900);

    // 1) Warm cream-gold ripples when tail slaps a key
    for (const rp of this.ripples) {
      ctx.save();
      ctx.globalAlpha = rp.life * 0.80;
      ctx.strokeStyle = '#f2c68a';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.ellipse(rp.x, rp.y, rp.r, rp.r * 0.55, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // 2) Thick-outline sticker cat tail slapping a key (only drawn when slapping so original tail stays clean at rest!)
    if (this.tail.phase > 0.08) {
      const tailRoot = g.spritePointToWorld(0.68, 0.72);
      const tipX = tailRoot.x + this.tail.relX;
      const tipY = tailRoot.y + this.tail.relY;
      this.drawStickerTailSlap(
        ctx,
        tailRoot.x,
        tailRoot.y,
        tipX,
        tipY,
        this.tail.phase,
        layout.logicalW,
      );
    }

    // 3) Matching thick-dark-brown-outline white paws!
    // Shown smoothly during typing, mousing, or password eye-covering (hidden in idle/happy so the original
    // hand-drawn sitting paws & raised cheering pink-pad paws shine completely untouched!)
    const leftTyping =
      !layout.privacyMode &&
      !mouseMode &&
      (now - this.leftHand.lastAt < 360 || this.leftHand.heldVks.size > 0);
    const rightTyping =
      !layout.privacyMode &&
      (now - this.rightHand.lastAt < 360 || this.rightHand.heldVks.size > 0);

    const showLeftPaw = layout.privacyMode || mouseMode || leftTyping;
    const showRightPaw = layout.privacyMode || rightTyping;

    // Anchor shoulders smoothly to the current sticker's front paws/sides
    const shL =
      mood === 'grumpy'
        ? g.spritePointToWorld(0.24, 0.88)
        : mood === 'surprised'
          ? g.spritePointToWorld(0.28, 0.78)
          : g.spritePointToWorld(0.28, 0.82);
    const shR =
      mood === 'grumpy'
        ? g.spritePointToWorld(0.60, 0.90)
        : mood === 'surprised'
          ? g.spritePointToWorld(0.72, 0.78)
          : g.spritePointToWorld(0.64, 0.82);

    let lTargetX = shL.x;
    let lTargetY = shL.y + 8;
    let rTargetX = shR.x;
    let rTargetY = shR.y + 8;

    if (layout.privacyMode) {
      // Surprised Hubao covers his huge green eyes with both thick-outline white paws!
      const eyeL = g.spritePointToWorld(0.35, 0.45);
      const eyeR = g.spritePointToWorld(0.65, 0.45);
      const shyBob = Math.sin(now * 0.008) * 1.4;
      lTargetX = eyeL.x;
      lTargetY = eyeL.y + shyBob;
      rTargetX = eyeR.x;
      rTargetY = eyeR.y - shyBob;
    } else {
      if (mouseMode) {
        const pressOff = layout.mouseLeft || layout.mouseRight ? 2.5 : 0;
        lTargetX = layout.mouseBtnX;
        lTargetY = layout.mouseBtnY + pressOff;
      } else if (leftTyping) {
        lTargetX = this.leftHand.tx;
        lTargetY = this.leftHand.ty;
      }
      if (rightTyping) {
        rTargetX = this.rightHand.tx;
        rTargetY = this.rightHand.ty;
      }
    }

    const hLerp = 1 - Math.exp(-32 * dt);
    this.leftHand.x += (lTargetX - this.leftHand.x) * hLerp;
    this.leftHand.y += (lTargetY - this.leftHand.y) * hLerp;
    this.rightHand.x += (rTargetX - this.rightHand.x) * hLerp;
    this.rightHand.y += (rTargetY - this.rightHand.y) * hLerp;
    this.leftHand.squash *= Math.exp(-14 * dt);
    this.rightHand.squash *= Math.exp(-14 * dt);

    const maxMouseReach = layout.is108 ? 106 : 96;
    if (showLeftPaw) {
      this.drawStickerPawArm(
        ctx,
        shL.x,
        shL.y,
        this.leftHand.x,
        this.leftHand.y,
        'left',
        this.leftHand.squash,
        layout.privacyMode ? 125 : mouseMode ? maxMouseReach : 92,
        layout.privacyMode,
      );
    }
    if (showRightPaw) {
      this.drawStickerPawArm(
        ctx,
        shR.x,
        shR.y,
        this.rightHand.x,
        this.rightHand.y,
        'right',
        this.rightHand.squash,
        layout.privacyMode ? 125 : mouseMode ? 96 : 92,
        layout.privacyMode,
      );
    }

    // 4) Original hand-drawn sticker FX particles (blue sigh cloud / pink heart / yellow star!)
    for (const p of this.particles) {
      const fxImg = this.fx[p.kind];
      if (!fxImg || !fxImg.complete || fxImg.naturalWidth <= 0) continue;
      ctx.save();
      const fadeIn = Math.min(1, (1 - p.life) * 5.5);
      const fadeOut = Math.min(1, p.life * 2.2);
      ctx.globalAlpha = Math.max(0, Math.min(1, fadeIn * fadeOut));
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      const baseSize = p.kind === 'sigh' ? 34 : 26;
      const aspect = fxImg.naturalWidth / fxImg.naturalHeight;
      const pop = 0.85 + Math.sin(Math.min(1, (1 - p.life) * 3) * Math.PI * 0.5) * 0.22;
      const dw = baseSize * p.scale * pop * aspect;
      const dh = baseSize * p.scale * pop;
      ctx.drawImage(fxImg, -dw * 0.5, -dh * 0.5, dw, dh);
      ctx.restore();
    }
  }

  /**
   * Thick dark-chocolate-brown sticker-outlined cream cat tail when slapping Enter/Space!
   */
  private drawStickerTailSlap(
    ctx: CanvasRenderingContext2D,
    rootX: number,
    rootY: number,
    tipX: number,
    tipY: number,
    slapPhase: number,
    logicalW: number,
  ): void {
    const crossLeft = Math.max(0, Math.min(1, (rootX + 24 - tipX) / 145));
    const nearCtrlX = Math.min(logicalW - 18, Math.max(rootX + 82, tipX + 38));
    const nearCtrlY = Math.min(rootY - 40, (rootY + tipY) * 0.5 - 56);
    const farCtrlX = Math.min(logicalW - 16, rootX + 92);
    const farCtrlY = Math.max(rootY + 24, tipY - 12);
    const ctrlX = nearCtrlX + (farCtrlX - nearCtrlX) * crossLeft;
    const ctrlY = nearCtrlY + (farCtrlY - nearCtrlY) * crossLeft;

    const steps = 14;
    const pts: Array<{ x: number; y: number; nx: number; ny: number; r: number }> = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const omt = 1 - t;
      const x = omt * omt * rootX + 2 * omt * t * ctrlX + t * t * tipX;
      const y = omt * omt * rootY + 2 * omt * t * ctrlY + t * t * tipY;
      const tx = 2 * omt * (ctrlX - rootX) + 2 * t * (tipX - ctrlX);
      const ty = 2 * omt * (ctrlY - rootY) + 2 * t * (tipY - ctrlY);
      const len = Math.max(0.001, Math.hypot(tx, ty));
      const nx = -ty / len;
      const ny = tx / len;
      const r = (10.5 + Math.sin(t * Math.PI) * 5.0) * (t > 0.7 ? 1 + this.tail.squash * 0.14 : 1);
      pts.push({ x, y, nx, ny, r });
    }

    const startIdx = Math.floor(steps * 0.35);
    const last = pts[pts.length - 1];
    const tipAng = Math.atan2(tipY - ctrlY, tipX - ctrlX);

    ctx.save();
    ctx.globalAlpha = Math.min(1, slapPhase * 2.2);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const tailGrad = ctx.createLinearGradient(rootX, rootY, tipX, tipY);
    tailGrad.addColorStop(0.0, '#edd4b4');
    tailGrad.addColorStop(0.55, '#f5e2c8');
    tailGrad.addColorStop(1.0, '#ebd0ad');

    ctx.beginPath();
    ctx.moveTo(
      pts[startIdx].x + pts[startIdx].nx * pts[startIdx].r,
      pts[startIdx].y + pts[startIdx].ny * pts[startIdx].r,
    );
    for (let i = startIdx + 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x + pts[i].nx * pts[i].r, pts[i].y + pts[i].ny * pts[i].r);
    }
    ctx.arc(last.x, last.y, last.r, tipAng + Math.PI / 2, tipAng - Math.PI / 2, true);
    for (let i = pts.length - 1; i >= startIdx; i--) {
      ctx.lineTo(pts[i].x - pts[i].nx * pts[i].r, pts[i].y - pts[i].ny * pts[i].r);
    }
    ctx.closePath();

    ctx.fillStyle = tailGrad;
    ctx.fill();

    // Signature thick dark-chocolate-brown hand-drawn sticker outline!
    ctx.strokeStyle = '#2d1c12';
    ctx.lineWidth = 3.8;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Thick dark-chocolate-brown sticker-outlined cream arm -> snowy white kitten paw!
   * Matches the user's hand-drawn Hubao sticker line weight & colors 1:1.
   */
  private drawStickerPawArm(
    ctx: CanvasRenderingContext2D,
    sx: number,
    sy: number,
    targetX: number,
    targetY: number,
    side: 'left' | 'right',
    squash: number,
    maxLen: number,
    isPrivacyCover: boolean,
  ): void {
    const dx = targetX - sx;
    const dy = targetY - sy;
    const rawLen = Math.max(1, Math.hypot(dx, dy));
    const len = Math.min(rawLen, maxLen);
    const ux = dx / rawLen;
    const uy = dy / rawLen;
    const px = sx + ux * len;
    const py = sy + uy * len;
    const nx = -uy;
    const ny = ux;
    const ang = Math.atan2(dy, dx);
    const sgn = side === 'left' ? -1 : 1;

    const rSh = 11.5;
    const rPaw = 11.2;
    const midX = (sx + px) * 0.5 + nx * (sgn * 3.0);
    const midY = (sy + py) * 0.5 + ny * (sgn * 3.0);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Creamy pastel fur transitioning smoothly into Hubao's white paw sock
    const armGrad = ctx.createLinearGradient(sx, sy, px, py);
    armGrad.addColorStop(0.0, '#f3dec2');
    armGrad.addColorStop(0.55, '#f8ecda');
    armGrad.addColorStop(0.82, '#fffdf9');
    armGrad.addColorStop(1.0, '#ffffff');

    ctx.beginPath();
    ctx.moveTo(sx + nx * rSh, sy + ny * rSh);
    ctx.quadraticCurveTo(midX + nx * 11.6, midY + ny * 11.6, px + nx * rPaw, py + ny * rPaw);
    ctx.arc(px, py, rPaw, ang + Math.PI / 2, ang - Math.PI / 2, true);
    ctx.quadraticCurveTo(midX - nx * 11.6, midY - ny * 11.6, sx - nx * rSh, sy - ny * rSh);
    ctx.closePath();
    ctx.fillStyle = armGrad;
    ctx.fill();

    // Thick dark-chocolate-brown sticker contour matching the original stickers (#2d1c12)
    ctx.strokeStyle = '#2d1c12';
    ctx.lineWidth = 3.6;
    ctx.beginPath();
    ctx.moveTo(sx + nx * rSh, sy + ny * rSh);
    ctx.quadraticCurveTo(midX + nx * 11.6, midY + ny * 11.6, px + nx * rPaw, py + ny * rPaw);
    ctx.arc(px, py, rPaw, ang + Math.PI / 2, ang - Math.PI / 2, true);
    ctx.quadraticCurveTo(midX - nx * 11.6, midY - ny * 11.6, sx - nx * rSh, sy - ny * rSh);
    ctx.stroke();

    // Plump round white sticker paw tip
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ang);
    ctx.scale(1 + squash * 0.16, 1 - squash * 0.11);

    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#2d1c12';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.ellipse(1.5, 0, 10.6, 11.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    if (!isPrivacyCover) {
      // Cute sticker-style toe divider ticks
      ctx.strokeStyle = '#5a4232';
      ctx.lineWidth = 1.9;
      ctx.beginPath();
      ctx.moveTo(6.0, -3.6);
      ctx.lineTo(10.8, -4.6);
      ctx.moveTo(6.0, 3.6);
      ctx.lineTo(10.8, 4.6);
      ctx.stroke();
    } else {
      // Cute pink sticker toe-beans peeking out when covering eyes!
      ctx.fillStyle = '#f39ca6';
      ctx.beginPath();
      ctx.ellipse(1.2, 0, 3.8, 4.6, 0, 0, Math.PI * 2);
      ctx.fill();
      for (const oy of [-5.2, 0, 5.2]) {
        ctx.beginPath();
        ctx.arc(5.6, oy * 0.72, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
    ctx.restore();
  }
}
