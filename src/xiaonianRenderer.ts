import baseUrl from './assets/xiaonian_live2d/xiaonian_base.png';
import tailUrl from './assets/xiaonian_live2d/xiaonian_tail.png';
import eatUrl from './assets/xiaonian_live2d/xiaonian_eat.png';
import sleepUrl from './assets/xiaonian_live2d/xiaonian_sleep.png';
import angerUrl from './assets/xiaonian_live2d/fx_anger.png';
import heartUrl from './assets/xiaonian_live2d/fx_heart.png';
import starUrl from './assets/xiaonian_live2d/fx_star.png';
import zzzUrl from './assets/xiaonian_live2d/fx_zzz.png';
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
  kind: 'anger' | 'heart' | 'star' | 'zzz';
}

const OUTLINE_COLOR = '#463122';

// Tail sprite (`xiaonian_tail.png`, 339x380) normalized root & tip anchors
const TAIL_ROOT_NX = 0.14;
const TAIL_ROOT_NY = 0.78;
const TAIL_TIP_NX = 0.88;
const TAIL_TIP_NY = 0.14;

/**
 * Full Live2D-style animated companion renderer for Xiaonian (小年) in the user's hand-drawn sticker style:
 * - Seamless pear-shaped fluffy cotton-ball base (`xiaonian_base.png`, 1:1 matching Xiaonian's sticker proportions,
 *   with NO giant beard/neck seam — her fluffy chest begins right beneath her mouth!)
 * - Real hand-drawn spiky-tufted fluffy tail sprite (`xiaonian_tail.png`) wagging behind her hip and whipping to slap keys!
 * - Smooth spring-physics cotton-ball sway, squash-and-stretch, and 2.5D face parallax
 * - Real-time 360° mouse & keycap-tracking sage-green eyes with cute slight inward convergence and blinking
 * - Crisp flat-topped grumpy typing eyes + floating hand-drawn anger mark (`💢`) when pounding keys
 * - Joyful curved laughing eyes + open smile + raised pink-toe-bean paws + purring when petted
 * - Privacy eye-cover with surprised 'O' mouth when typing in password fields
 * - Configurable Rest Mode: randomly chooses 50/50 each rest cycle between
 *   EATING grilled fish on a fork (`xiaonian_eat.png`) OR SLEEPING hugging a blue plush fish (`xiaonian_sleep.png`)!
 */
export class XiaonianRenderer {
  private baseImg: HTMLImageElement;
  private tailImg: HTMLImageElement;
  private eatImg: HTMLImageElement;
  private sleepImg: HTMLImageElement;
  private fx: Record<'anger' | 'heart' | 'star' | 'zzz', HTMLImageElement>;

  private lastKeyAt = -10000;
  private lastKeyGazeAt = -10000;
  private lastKeyPtX = 214;
  private lastKeyPtY = 353;
  private lastMouseClickAt = -10000;
  private grumpyUntil = -10000;
  private lastAngerAt = -10000;
  private nextRestFxAt = 0;
  private keyTimes: number[] = [];
  private typingHeat = 0;

  // Random rest activity picked once per rest session: eat grilled fish vs sleep hugging blue fish
  private restMode: 'eat' | 'sleep' = 'eat';
  private restModePicked = false;

  // Smooth expression blend weights (0..1)
  private grumpyAmount = 0;
  private happyAmount = 0;
  private privacyAmount = 0;
  private restAmount = 0;
  private blinkAmount = 0;
  private nextBlinkAt = performance.now() + 2600 + Math.random() * 2600;
  private blinkPhase = -1;

  // Live2D eye gaze (-1..1 normalized) & 2.5D head/body spring motion
  private eyeGazeX = 0;
  private eyeGazeY = 0;
  private headTilt = 0;
  private headTiltVel = 0;
  private headTiltTarget = 0;
  private headNodY = 0;

  // Body spring physics
  private bodyShiftX = 0;
  private bodyShiftVel = 0;
  private bodyShiftTarget = 0;
  private bodyTilt = 0;
  private bodyTiltVel = 0;
  private bodyTiltTarget = 0;
  private bodyDiveY = 0;
  private bodyBob = 0;

  private leftHand: PawState = {
    x: 158,
    y: 318,
    tx: 158,
    ty: 318,
    lastAt: -10000,
    squash: 0,
    heldVks: new Set(),
  };
  private rightHand: PawState = {
    x: 234,
    y: 318,
    tx: 234,
    ty: 318,
    lastAt: -10000,
    squash: 0,
    heldVks: new Set(),
  };

  private tail = {
    relX: 82,
    relY: -78,
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
    this.baseImg = mk(baseUrl);
    this.tailImg = mk(tailUrl);
    this.eatImg = mk(eatUrl);
    this.sleepImg = mk(sleepUrl);
    this.fx = {
      anger: mk(angerUrl),
      heart: mk(heartUrl),
      star: mk(starUrl),
      zzz: mk(zzzUrl),
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

  public onMouseAction(now: number = performance.now()): void {
    this.lastMouseClickAt = now;
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
    this.lastKeyGazeAt = now;
    this.lastKeyPtX = pt.x;
    this.lastKeyPtY = pt.y;
    this.grumpyUntil = Math.max(this.grumpyUntil, now + 1500);
    this.tail.slapAt = now;
    this.tail.releaseAt = now + 220;
    this.tail.slapTargetX = pt.x;
    this.tail.slapTargetY = pt.y;
    this.tail.squash = 1;
    this.bodyBob = Math.min(1.0, this.bodyBob + 0.58);
    const normX = Math.max(-1, Math.min(1, (pt.x - layout.kbCenterX) / (layout.kbWidth * 0.46)));
    this.bodyTiltTarget = normX * 0.06;
    this.bodyShiftTarget = normX * 8;
    this.ripples.push({ x: pt.x, y: pt.y, r: 5, life: 1 });
    this.spawnAngerMark(layout, now, true);
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
    this.lastKeyGazeAt = now;
    this.lastKeyPtX = pt.x;
    this.lastKeyPtY = pt.y;
    this.grumpyUntil = now + 1500;
    this.keyTimes.push(now);
    this.bodyBob = Math.min(1.1, this.bodyBob + 0.72);

    if (wasIdle || now - this.lastAngerAt > Math.max(720, 1550 - this.typingHeat * 800)) {
      this.spawnAngerMark(layout, now, false);
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
        this.bodyTiltTarget = normX >= 0 ? -0.065 : 0.05;
        this.bodyShiftTarget = normX >= 0 ? -6 : 7;
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
      this.bodyTiltTarget = normX * 0.075;
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

  private spawnAngerMark(layout: DaFeiYuLayout, now: number, force: boolean): void {
    if (!force && now - this.lastAngerAt < 600) return;
    this.lastAngerAt = now;
    const charX = (layout.is108 ? 268 : 196) + this.bodyShiftX;
    const side = Math.random() > 0.35 ? -1 : 1;
    this.particles.push({
      x: charX + side * (62 + Math.random() * 14),
      y: 132 + (Math.random() - 0.5) * 18,
      vx: side * (0.22 + Math.random() * 0.2),
      vy: -0.65 - Math.random() * 0.35,
      life: 1,
      scale: 0.78 + Math.random() * 0.22,
      rot: (Math.random() - 0.5) * 0.24,
      vrot: (Math.random() - 0.5) * 0.012,
      kind: 'anger',
    });
  }

  private spawnJoyParticle(x: number, y: number): void {
    const isHeart = Math.random() > 0.45;
    this.particles.push({
      x: x + (Math.random() - 0.5) * 105,
      y: y + (Math.random() - 0.5) * 24,
      vx: (Math.random() - 0.5) * 0.72,
      vy: -0.95 - Math.random() * 0.75,
      life: 1,
      scale: isHeart ? 0.72 + Math.random() * 0.24 : 0.68 + Math.random() * 0.26,
      rot: (Math.random() - 0.5) * 0.24,
      vrot: (Math.random() - 0.5) * 0.018,
      kind: isHeart ? 'heart' : 'star',
    });
  }

  public update(dt: number, now: number, layout: DaFeiYuLayout): void {
    this.bodyBob *= Math.exp(-12 * dt);

    const isPetted = !layout.privacyMode && layout.petEnergy > 0.25;
    const isWorking =
      !layout.privacyMode &&
      !isPetted &&
      (now < this.grumpyUntil ||
        this.leftHand.heldVks.size > 0 ||
        this.rightHand.heldVks.size > 0 ||
        this.tail.heldVks.size > 0);
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

    const sleepSec = typeof layout.sleepAfterSec === 'number' ? layout.sleepAfterSec : 30;
    const idleMs = layout.idleMs ?? 0;
    const isResting =
      sleepSec > 0 &&
      !layout.privacyMode &&
      !isPetted &&
      !isWorking &&
      !mouseMode &&
      idleMs >= sleepSec * 1000;

    // Pick randomly between EATING grilled fish and SLEEPING with plush blue fish once per rest session!
    if (isResting && !this.restModePicked) {
      this.restMode = Math.random() < 0.5 ? 'eat' : 'sleep';
      this.restModePicked = true;
      this.nextRestFxAt = now + 450;
    } else if (!isResting && this.restAmount < 0.08) {
      this.restModePicked = false;
    }

    const wantGrumpy = isWorking ? 1 : 0;
    const wantHappy = isPetted ? 1 : 0;
    const wantPrivacy = layout.privacyMode ? 1 : 0;
    const wantRest = isResting ? 1 : 0;
    this.grumpyAmount += (wantGrumpy - this.grumpyAmount) * (1 - Math.exp(-(wantGrumpy ? 18 : 6.5) * dt));
    this.happyAmount += (wantHappy - this.happyAmount) * (1 - Math.exp(-13 * dt));
    this.privacyAmount += (wantPrivacy - this.privacyAmount) * (1 - Math.exp(-14 * dt));
    this.restAmount += (wantRest - this.restAmount) * (1 - Math.exp(-(wantRest ? 3.8 : 12.0) * dt));
    if (this.restAmount < 0.002 && wantRest === 0) this.restAmount = 0;

    // Spawn cozy rest FX particles depending on whether Xiaonian chose SLEEP or EAT!
    if (this.restAmount > 0.65 && now >= this.nextRestFxAt) {
      const charX = (layout.is108 ? 268 : 196) + this.bodyShiftX;
      const kbTopEdge = layout.kbCenterY - layout.kbHeight * 0.34;
      if (this.restMode === 'sleep') {
        this.nextRestFxAt = now + 1050 + Math.random() * 350;
        this.particles.push({
          x: charX + 46 + (Math.random() - 0.5) * 16,
          y: kbTopEdge - 104 + (Math.random() - 0.5) * 10,
          vx: 0.38 + Math.random() * 0.25,
          vy: -0.62 - Math.random() * 0.22,
          life: 1,
          scale: 0.72 + Math.random() * 0.25,
          rot: -0.10 + (Math.random() - 0.5) * 0.14,
          vrot: (Math.random() - 0.5) * 0.008,
          kind: 'zzz',
        });
      } else {
        this.nextRestFxAt = now + 1100 + Math.random() * 450;
        const isHeart = Math.random() > 0.35;
        this.particles.push({
          x: charX + (isHeart ? -64 : 62) + (Math.random() - 0.5) * 26,
          y: kbTopEdge - 135 + (Math.random() - 0.5) * 18,
          vx: (Math.random() - 0.5) * 0.45,
          vy: -0.72 - Math.random() * 0.32,
          life: 1,
          scale: 0.68 + Math.random() * 0.24,
          rot: (Math.random() - 0.5) * 0.22,
          vrot: (Math.random() - 0.5) * 0.015,
          kind: isHeart ? 'heart' : 'star',
        });
      }
    }

    // Smooth natural blinking
    if (this.blinkPhase < 0 && now >= this.nextBlinkAt && !isPetted && !layout.privacyMode) {
      this.blinkPhase = 0;
    }
    if (this.blinkPhase >= 0) {
      this.blinkPhase += dt * 7.2;
      if (this.blinkPhase >= 1) {
        this.blinkPhase = -1;
        this.blinkAmount = 0;
        this.nextBlinkAt = now + 3000 + Math.random() * 2900;
      } else {
        this.blinkAmount = Math.sin(this.blinkPhase * Math.PI);
      }
    } else {
      this.blinkAmount = 0;
    }

    while (this.keyTimes.length && now - this.keyTimes[0] > 2600) {
      this.keyTimes.shift();
    }
    const typingCPS = this.keyTimes.length / 2.6;
    const heatTarget = layout.privacyMode ? 0 : Math.min(1, Math.max(0, (typingCPS - 1.4) / 4.5));
    this.typingHeat +=
      (heatTarget - this.typingHeat) * (1 - Math.exp(-(heatTarget > this.typingHeat ? 2.6 : 0.85) * dt));

    const charX = layout.is108 ? 268 : 196;
    if (isPetted && Math.random() < 0.085) {
      this.spawnJoyParticle(charX + this.bodyShiftX, 134);
    }

    // Body spring physics
    if (layout.privacyMode) {
      this.bodyShiftTarget = 0;
      const shySway =
        Math.sin(now * 0.0045) * 0.032 +
        (now - layout.privacyTypingAt < 240 ? Math.sin(now * 0.04) * 0.022 : 0);
      this.bodyTiltTarget = shySway;
      this.bodyDiveY *= Math.exp(-9 * dt);
    } else if (isPetted) {
      this.bodyShiftTarget = 0;
      this.bodyTiltTarget = Math.sin(now * 0.010) * 0.065;
      this.bodyDiveY *= Math.exp(-9 * dt);
    } else if (mouseMode) {
      const baseShift = layout.is108 ? -116 : -32;
      this.bodyShiftTarget = baseShift + (layout.mouseNX - 0.5) * 14;
      this.bodyTiltTarget = -0.075;
      this.bodyDiveY += (6 - this.bodyDiveY) * (1 - Math.exp(-10 * dt));
    } else if (!isTypingActive) {
      this.bodyShiftTarget = 0;
      this.bodyTiltTarget = 0;
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

    // Live2D Eye Gaze (tracks BOTH global mouse cursor 360° AND active keycaps)
    const mxNorm = Math.max(-1, Math.min(1, (layout.mouseNX - 0.5) * 2.1));
    const myNorm = Math.max(-1, Math.min(1, ((layout.mouseNY ?? 0.5) - 0.5) * 2.1));
    const lastClickTs = Math.max(this.lastMouseClickAt, layout.mouseClickAt || -10000);
    const activeKeyGaze =
      !layout.privacyMode &&
      !isPetted &&
      (now - this.lastKeyGazeAt < 1100 ||
        this.leftHand.heldVks.size > 0 ||
        this.rightHand.heldVks.size > 0 ||
        this.tail.heldVks.size > 0);
    const recentMouseMove = now - layout.mouseActiveAt < 2500 || now - lastClickTs < 1500;

    let gazeTx = mxNorm * 0.85;
    let gazeTy = myNorm * 0.72;

    if (layout.privacyMode || isPetted) {
      gazeTx = 0;
      gazeTy = 0;
    } else if (activeKeyGaze && (!mouseMode || this.lastKeyGazeAt >= lastClickTs)) {
      const g = this.computeGeom(now, layout);
      const dx = this.lastKeyPtX - g.faceCenterX;
      const dy = this.lastKeyPtY - g.faceCenterY;
      gazeTx = Math.max(-1, Math.min(1, dx / 95));
      gazeTy = Math.max(0.15, Math.min(1, dy / 145));
    } else if (recentMouseMove) {
      gazeTx = mxNorm;
      gazeTy = myNorm;
    } else {
      gazeTx = Math.sin(now * 0.0009) * 0.25;
      gazeTy = Math.cos(now * 0.0007) * 0.12;
    }

    const gazeRate = activeKeyGaze || recentMouseMove ? 18 : 6.5;
    const gazeLerp = 1 - Math.exp(-gazeRate * dt);
    this.eyeGazeX += (gazeTx - this.eyeGazeX) * gazeLerp;
    this.eyeGazeY += (gazeTy - this.eyeGazeY) * gazeLerp;

    // Expressive cotton-ball tilt & nod toward mouse / keystrokes / petting
    if (layout.privacyMode) {
      this.headTiltTarget = Math.sin(now * 0.0055) * 0.055;
    } else if (isPetted) {
      this.headTiltTarget = Math.sin(now * 0.0115) * 0.12;
    } else if (activeKeyGaze) {
      const keyBias = Math.max(-1, Math.min(1, (this.lastKeyPtX - layout.kbCenterX) / (layout.kbWidth * 0.45)));
      this.headTiltTarget = keyBias * 0.10 + Math.sin(now * 0.009) * 0.022;
    } else {
      this.headTiltTarget = this.eyeGazeX * 0.095 + Math.sin(now * 0.0018) * 0.020;
    }
    const hTiltAcc = (this.headTiltTarget - this.headTilt) * 145 - this.headTiltVel * 15;
    this.headTiltVel += hTiltAcc * dt;
    this.headTilt += this.headTiltVel * dt;

    const targetNodY =
      this.grumpyAmount * 8.5 +
      this.eyeGazeY * 3.8 +
      this.bodyBob * 3.8 -
      this.happyAmount * 3.0;
    this.headNodY += (targetNodY - this.headNodY) * (1 - Math.exp(-14 * dt));

    // Fluffy hand-drawn tail wag & key-slap physics anchored to lower right hip
    const gTail = this.computeGeom(now, layout);
    const tailRoot = gTail.basePointToWorld(0.76, 0.78);
    const wagSpeed = isPetted
      ? 0.013
      : isWorking
        ? 0.010 + this.typingHeat * 0.005
        : 0.0038;
    const idleWag = Math.sin(now * wagSpeed) * (isPetted ? 0.28 : 0.15 + this.typingHeat * 0.11);
    const maxIdleOffX = Math.max(58, Math.min(86, layout.logicalW - 22 - tailRoot.x));
    const idleOffX = maxIdleOffX + Math.sin(now * wagSpeed) * 8;
    const idleOffY = -66 + Math.cos(now * wagSpeed * 1.15) * 6;

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

    const slapOffX = this.tail.slapTargetX - tailRoot.x;
    const slapOffY = this.tail.slapTargetY - tailRoot.y;
    const targetRelX = idleOffX + (slapOffX - idleOffX) * this.tail.phase;
    const targetRelY = idleOffY + (slapOffY - idleOffY) * this.tail.phase;
    const tLerp = 1 - Math.exp(-36 * dt);
    this.tail.relX += (targetRelX - this.tail.relX) * tLerp;
    this.tail.relY += (targetRelY - this.tail.relY) * tLerp;
    this.tail.squash *= Math.exp(-11 * dt);
    this.tail.activeWag = idleWag * (1 - this.tail.phase);

    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const rp = this.ripples[i];
      rp.r += 54 * dt;
      rp.life -= 2.4 * dt;
      if (rp.life <= 0) this.ripples.splice(i, 1);
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx + (p.kind === 'zzz' ? Math.sin(now * 0.004 + i * 2) * 0.22 : 0);
      p.y += p.vy;
      p.rot += p.vrot;
      p.life -= (p.kind === 'zzz' ? 0.0085 : p.kind === 'anger' ? 0.017 : 0.019) * (dt * 60);
      if (p.life <= 0) this.particles.splice(i, 1);
    }
  }

  private computeGeom(now: number, layout: DaFeiYuLayout) {
    const charX = layout.is108 ? 268 : 196;
    const kbTopEdge = layout.kbCenterY - layout.kbHeight * 0.34;
    const breath = Math.sin(now * 0.0034) * 2.0 + this.bodyBob * 3.0 + this.bodyDiveY;

    // Compact seamless pear-shaped cotton-ball proportions (xiaonian_base.png is 456x520)
    // Matches Hubao's cozy desktop footprint — NO oversized head, NO double-decker snowman!
    const baseW = layout.is108 ? 228 : 216;
    const baseH = baseW * (520 / 456);

    const pivotX = charX + this.bodyShiftX + this.eyeGazeX * 2.2;
    const baseBottomY = kbTopEdge + 26 + breath + this.headNodY * 0.45;
    const pivotY = baseBottomY - 24;
    const totalTilt = this.bodyTilt * 0.60 + this.headTilt * 0.85;

    const c = Math.cos(totalTilt);
    const s = Math.sin(totalTilt);

    const basePointToWorld = (normX: number, normY: number) => {
      const lx = (normX - 0.5) * baseW;
      const ly = normY * baseH - baseH + 24;
      return {
        x: pivotX + lx * c - ly * s,
        y: pivotY + lx * s + ly * c,
      };
    };

    const faceCenter = basePointToWorld(0.514, 0.32);

    return {
      baseW,
      baseH,
      pivotX,
      pivotY,
      totalTilt,
      faceCenterX: faceCenter.x,
      faceCenterY: faceCenter.y,
      basePointToWorld,
    };
  }

  /** Layer 1 (BEFORE keyboard & mouse): awake seamless Live2D Xiaonian OR random Rest Mode (Eat / Sleep)! */
  public renderBody(ctx: CanvasRenderingContext2D, now: number, layout: DaFeiYuLayout): void {
    const awakeAlpha = Math.max(0, 1 - this.restAmount * 1.15);
    const restAlpha = Math.min(1, this.restAmount * 1.15);

    if (awakeAlpha > 0.01) {
      const g = this.computeGeom(now, layout);
      ctx.save();
      ctx.globalAlpha = awakeAlpha;
      const sinkY = this.restAmount * 22;
      ctx.translate(0, sinkY);

      // 1) Big fluffy spiky-tufted hand-drawn tail behind right hip (when wagging / not slapping front)
      if (this.tail.phase <= 0.25) {
        const tailRoot = g.basePointToWorld(0.76, 0.78);
        this.drawFluffyTailSprite(ctx, tailRoot.x, tailRoot.y, layout);
      }

      ctx.save();
      // Clip cleanly along the top edge of the keyboard so Xiaonian rests cozily behind it
      ctx.beginPath();
      ctx.rect(0, 0, layout.logicalW, layout.kbCenterY - layout.kbHeight * 0.28);
      ctx.clip();

      // 2) Seamless pear-shaped fluffy cotton-ball Xiaonian + dynamic Live2D eyes & mouth!
      if (this.baseImg.complete && this.baseImg.naturalWidth > 0) {
        ctx.save();
        ctx.translate(g.pivotX, g.pivotY);
        ctx.rotate(g.totalTilt);
        const sqX = 1 + this.bodyBob * 0.028 + Math.sin(now * 0.0034) * 0.009;
        const sqY = 1 - this.bodyBob * 0.024 - Math.sin(now * 0.0034) * 0.008;
        ctx.scale(sqX, sqY);

        ctx.drawImage(this.baseImg, -g.baseW * 0.5, -g.baseH + 24, g.baseW, g.baseH);
        this.renderLiveFace(ctx, g.baseW, g.baseH);
        ctx.restore();
      }

      ctx.restore();
      ctx.restore();
    }

    // 3) Random Rest Mode: EITHER eating grilled fish on fork OR sleeping hugging plush blue fish!
    if (restAlpha > 0.01) {
      const charX = (layout.is108 ? 268 : 196) + this.bodyShiftX;
      const kbTopEdge = layout.kbCenterY - layout.kbHeight * 0.32;

      if (this.restMode === 'eat' && this.eatImg.complete && this.eatImg.naturalWidth > 0) {
        const eatW = layout.is108 ? 244 : 230;
        const eatH = eatW * (this.eatImg.naturalHeight / this.eatImg.naturalWidth);
        const munch = Math.sin(now * 0.0056);
        const sway = Math.sin(now * 0.0028) * 0.026;
        const sx = 1 + munch * 0.024;
        const sy = 1 - munch * 0.022;

        ctx.save();
        ctx.globalAlpha = restAlpha;
        ctx.translate(charX - 6, kbTopEdge + 12 + (1 - restAlpha) * 14);
        ctx.rotate(sway);
        ctx.scale(sx, sy);
        ctx.drawImage(this.eatImg, -eatW * 0.5, -eatH, eatW, eatH);
        ctx.restore();
      } else if (this.sleepImg.complete && this.sleepImg.naturalWidth > 0) {
        const sleepW = layout.is108 ? 264 : 250;
        const sleepH = sleepW * (this.sleepImg.naturalHeight / this.sleepImg.naturalWidth);
        const slowBreath = Math.sin(now * 0.0020);
        const sx = 1 + slowBreath * 0.024;
        const sy = 1 - slowBreath * 0.020;

        ctx.save();
        ctx.globalAlpha = restAlpha;
        ctx.translate(charX, kbTopEdge + 14 + (1 - restAlpha) * 14);
        ctx.scale(sx, sy);
        ctx.drawImage(this.sleepImg, -sleepW * 0.5, -sleepH, sleepW, sleepH);
        ctx.restore();
      }
    }
  }

  /**
   * Draws Live2D mouse-tracking sage-green eyes, blinking, clean flat-topped grumpy typing eyes,
   * happy laughing curved eyes + open smile, and surprised privacy 'O' mouth aligned to xiaonian_base.png!
   */
  private renderLiveFace(ctx: CanvasRenderingContext2D, baseW: number, baseH: number): void {
    const faceShiftX = this.eyeGazeX * 4.6;
    const faceShiftY = this.eyeGazeY * 2.8 + this.headNodY * 0.45;

    // Measured exact landmarks on xiaonian_base.png (456x520):
    // leftBlush=(0.338, 0.402), nose=(0.514, 0.363, botY=0.375), rightBlush=(0.694, 0.361)
    // Natural cute head-tilt angle matching the blush line (~ -0.095 rad)
    const noseX = (0.514 - 0.5) * baseW;
    const noseY = 0.363 * baseH - baseH + 24;
    const faceBaseTilt = -0.092;

    const eyeSpanX = baseW * 0.132;
    const eyeOffsetAboveNose = -baseH * 0.048;
    const eyeRx = baseW * 0.073;
    const eyeRy = baseW * 0.072;

    const showHappyFace = this.happyAmount > 0.35;

    ctx.save();
    ctx.translate(noseX + faceShiftX * 0.45, noseY + faceShiftY * 0.40);
    ctx.rotate(faceBaseTilt);

    // 1) EYES
    for (const side of [-1, 1] as const) {
      const ecx = side * eyeSpanX + faceShiftX * 0.28;
      const ecy = eyeOffsetAboveNose + faceShiftY * 0.18;

      if (showHappyFace) {
        ctx.save();
        ctx.strokeStyle = OUTLINE_COLOR;
        ctx.lineWidth = 4.2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(ecx, ecy + eyeRy * 0.32, eyeRx * 0.80, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      if (this.blinkAmount > 0.82) {
        ctx.save();
        ctx.strokeStyle = OUTLINE_COLOR;
        ctx.lineWidth = 3.6;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(ecx, ecy - eyeRy * 0.1, eyeRx * 0.76, Math.PI * 0.14, Math.PI * 0.86);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      ctx.save();
      const openScaleY = Math.max(0.18, 1 - this.blinkAmount * 0.85);
      ctx.translate(ecx, ecy);
      ctx.scale(1, openScaleY);

      const gAmt = this.grumpyAmount;

      const traceEyeShape = () => {
        if (gAmt <= 0.02) {
          ctx.beginPath();
          ctx.ellipse(0, 0, eyeRx, eyeRy, 0, 0, Math.PI * 2);
          return;
        }
        const cutBaseY = -eyeRy * (1.0 - 0.56 * gAmt);
        const slant = eyeRy * 0.19 * gAmt;
        const yLeft = side === -1 ? cutBaseY - slant : cutBaseY + slant;
        const yRight = side === -1 ? cutBaseY + slant : cutBaseY - slant;

        const clampRatio = (yVal: number) => Math.max(-0.96, Math.min(0.96, yVal / eyeRy));
        const sinL = clampRatio(yLeft);
        const sinR = clampRatio(yRight);
        const xLeft = -eyeRx * Math.sqrt(Math.max(0.04, 1 - sinL * sinL));
        const xRight = eyeRx * Math.sqrt(Math.max(0.04, 1 - sinR * sinR));

        const angLeft = Math.atan2(yLeft / eyeRy, xLeft / eyeRx);
        const angRight = Math.atan2(yRight / eyeRy, xRight / eyeRx);

        ctx.beginPath();
        ctx.moveTo(xLeft, yLeft);
        ctx.lineTo(xRight, yRight);
        const endAng = angLeft < angRight ? angLeft + Math.PI * 2 : angLeft;
        ctx.ellipse(0, 0, eyeRx, eyeRy, 0, angRight, endAng, false);
        ctx.closePath();
      };

      ctx.save();
      traceEyeShape();
      ctx.clip();

      // Soft pale creamy-olive iris 1:1 matching Xiaonian's reference sticker
      const irisGrad = ctx.createRadialGradient(0, eyeRy * 0.28, 1.5, 0, 0, eyeRx * 1.15);
      irisGrad.addColorStop(0.0, '#e3e8cf');
      irisGrad.addColorStop(0.55, '#bac5a3');
      irisGrad.addColorStop(1.0, '#8d9b79');
      ctx.fillStyle = irisGrad;
      ctx.fillRect(-eyeRx - 3, -eyeRy - 3, eyeRx * 2 + 6, eyeRy * 2 + 6);

      // Exact pupil placement matching Xiaonian's sitting sticker:
      // gentle top-inner offset revealing the soft creamy-olive lower-outer iris crescent + smooth 360° tracking!
      const inwardBiasX = -side * (eyeRx * (0.11 - gAmt * 0.04));
      const baseBiasY = -eyeRy * (0.10 + gAmt * 0.11);
      let px = inwardBiasX + this.eyeGazeX * (eyeRx * 0.22);
      let py = baseBiasY + this.eyeGazeY * (eyeRy * 0.20);
      const maxShift = eyeRx * 0.34;
      const pMag = Math.hypot(px, py);
      if (pMag > maxShift) {
        px = (px / pMag) * maxShift;
        py = (py / pMag) * maxShift;
      }

      // Large innocent dark-espresso pupil matching the reference sticker proportions
      const pupilRx = eyeRx * 0.72;
      const pupilRy = eyeRy * 0.74;

      ctx.fillStyle = '#2b1f18';
      ctx.beginPath();
      ctx.ellipse(px, py, pupilRx, pupilRy, 0, 0, Math.PI * 2);
      ctx.fill();

      // Subtle glossy sage reflection hugging the lower pupil edge
      ctx.strokeStyle = 'rgba(220, 232, 194, 0.28)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(px, py + 0.4, pupilRx * 0.78, Math.PI * 0.16, Math.PI * 0.84);
      ctx.stroke();

      // Crisp signature single round catchlight at upper-left of each pupil
      const hlX = px - pupilRx * 0.30;
      const hlY = py - pupilRy * (0.28 - gAmt * 0.14);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(hlX, hlY, eyeRx * (0.25 - gAmt * 0.06), 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();

      ctx.strokeStyle = OUTLINE_COLOR;
      ctx.lineWidth = 2.7;
      ctx.lineJoin = 'round';
      traceEyeShape();
      ctx.stroke();

      // Slightly bolder upper lash curve at rest (matching real Xiaonian's crisp dark upper eyeliner!)
      if (gAmt <= 0.15) {
        ctx.strokeStyle = OUTLINE_COLOR;
        ctx.lineWidth = 3.6;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.ellipse(0, 0, eyeRx, eyeRy, 0, Math.PI * 1.12, Math.PI * 1.88);
        ctx.stroke();
      }

      if (gAmt > 0.08) {
        const cutBaseY = -eyeRy * (1.0 - 0.56 * gAmt);
        const slant = eyeRy * 0.19 * gAmt;
        const yLeft = side === -1 ? cutBaseY - slant : cutBaseY + slant;
        const yRight = side === -1 ? cutBaseY + slant : cutBaseY - slant;
        const sinL = Math.max(-0.96, Math.min(0.96, yLeft / eyeRy));
        const sinR = Math.max(-0.96, Math.min(0.96, yRight / eyeRy));
        const xLeft = -eyeRx * Math.sqrt(Math.max(0.04, 1 - sinL * sinL));
        const xRight = eyeRx * Math.sqrt(Math.max(0.04, 1 - sinR * sinR));
        const outerExt = 2.8 * gAmt;

        ctx.strokeStyle = OUTLINE_COLOR;
        ctx.lineWidth = 3.0 + 1.1 * gAmt;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(xLeft - (side === -1 ? outerExt : 0), yLeft);
        ctx.lineTo(xRight + (side === 1 ? outerExt : 0), yRight);
        ctx.stroke();
      }

      ctx.restore();
    }

    // 2) DYNAMIC MOUTH (directly beneath the tiny pink triangle nose!)
    ctx.save();
    ctx.translate(0, baseH * 0.024);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (this.privacyAmount > 0.35) {
      ctx.fillStyle = '#cf5262';
      ctx.strokeStyle = OUTLINE_COLOR;
      ctx.lineWidth = 2.8;
      ctx.beginPath();
      ctx.ellipse(0, 9.0, 6.4, 9.0, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ffa0ae';
      ctx.beginPath();
      ctx.ellipse(0, 12.8, 4.0, 4.2, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (showHappyFace) {
      ctx.fillStyle = '#d45566';
      ctx.strokeStyle = OUTLINE_COLOR;
      ctx.lineWidth = 2.8;
      ctx.beginPath();
      ctx.moveTo(-7.6, 3.0);
      ctx.quadraticCurveTo(0, 18.8, 7.6, 3.0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ffa4b2';
      ctx.beginPath();
      ctx.ellipse(0, 9.8, 4.0, 3.3, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = OUTLINE_COLOR;
      ctx.lineWidth = 3.0;
      ctx.beginPath();
      ctx.moveTo(-9.8, 1.8);
      ctx.quadraticCurveTo(-4.8, 6.4, 0, 1.6);
      ctx.quadraticCurveTo(4.8, 6.4, 9.8, 1.8);
      ctx.stroke();
    } else {
      // Real Xiaonian's signature cute little underbite ("小地包天" 天然微不高兴感):
      // soft downturned '人' cat pout with her plump little rosy-pink lower lip peeking out underneath!
      const poutExtra = this.grumpyAmount * 2.2;
      // Cute rosy underbite lower lip puff right beneath the center of '人'
      ctx.fillStyle = '#f2a3b1';
      ctx.beginPath();
      ctx.ellipse(0, 6.2 + poutExtra * 0.35, 4.4, 2.7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255, 224, 230, 0.55)';
      ctx.beginPath();
      ctx.ellipse(-0.8, 5.5 + poutExtra * 0.35, 2.0, 1.0, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = OUTLINE_COLOR;
      ctx.lineWidth = 2.7;
      ctx.beginPath();
      ctx.moveTo(0, -1.6);
      ctx.lineTo(0, 2.6);
      ctx.moveTo(-7.6 - poutExtra * 0.35, 8.2 + poutExtra);
      ctx.quadraticCurveTo(-3.4, 4.8, 0, 2.6);
      ctx.quadraticCurveTo(3.4, 4.8, 7.6 + poutExtra * 0.35, 8.2 + poutExtra);
      ctx.stroke();
    }

    ctx.restore();
    ctx.restore();
  }

  /** Layer 2 (AFTER keyboard & mouse): chest-connected snow-white paws, slapping fluffy tail & Xiaonian FX! */
  public renderForeground(
    ctx: CanvasRenderingContext2D,
    dt: number,
    now: number,
    layout: DaFeiYuLayout,
  ): void {
    const g = this.computeGeom(now, layout);
    // Shoulders tucked neatly beneath Xiaonian's fluffy chest bib ("口水兜") so paws peek out from underneath!
    const shL = g.basePointToWorld(0.32, 0.66);
    const shR = g.basePointToWorld(0.68, 0.66);
    const tailRoot = g.basePointToWorld(0.76, 0.78);

    const isPetted = !layout.privacyMode && layout.petEnergy > 0.25;
    const mouseMode =
      !layout.privacyMode &&
      !isPetted &&
      (layout.mouseLeft || layout.mouseRight || now - layout.mouseActiveAt < 900);

    // 1) Pastel sky-blue ripples when fluffy tail slaps a key
    for (const rp of this.ripples) {
      ctx.save();
      ctx.globalAlpha = rp.life * 0.80;
      ctx.strokeStyle = '#8ecae6';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.ellipse(rp.x, rp.y, rp.r, rp.r * 0.55, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    const awakeAlpha = Math.max(0, 1 - this.restAmount * 1.25);

    // 2) Fluffy hand-drawn tail whipping over keyboard when slapping a key!
    if (awakeAlpha > 0.01 && this.tail.phase > 0.25) {
      ctx.save();
      ctx.globalAlpha = awakeAlpha;
      this.drawFluffyTailSprite(ctx, tailRoot.x, tailRoot.y, layout);
      ctx.restore();
    }

    // 3) Unified fluffy milky-white paws emerging directly from Xiaonian's chest!
    const leftTyping =
      !layout.privacyMode &&
      !mouseMode &&
      (now - this.leftHand.lastAt < 380 || this.leftHand.heldVks.size > 0);
    const rightTyping =
      !layout.privacyMode &&
      (now - this.rightHand.lastAt < 380 || this.rightHand.heldVks.size > 0);

    let lTargetX: number;
    let lTargetY: number;
    let rTargetX: number;
    let rTargetY: number;
    let showToeBeans = false;

    if (layout.privacyMode) {
      const eyeL = g.basePointToWorld(0.36, 0.31);
      const eyeR = g.basePointToWorld(0.66, 0.28);
      const shyBob = Math.sin(now * 0.008) * 1.4;
      lTargetX = eyeL.x;
      lTargetY = eyeL.y + shyBob;
      rTargetX = eyeR.x;
      rTargetY = eyeR.y - shyBob;
      showToeBeans = true;
    } else if (isPetted) {
      const wave = Math.sin(now * 0.015) * 7.5;
      lTargetX = shL.x - 42;
      lTargetY = shL.y - 34 + wave;
      rTargetX = shR.x + 42;
      rTargetY = shR.y - 34 - wave;
      showToeBeans = true;
    } else {
      const kbTopRestY = layout.kbCenterY - layout.kbHeight * 0.34;
      if (mouseMode) {
        const pressOff = layout.mouseLeft || layout.mouseRight ? 2.5 : 0;
        lTargetX = layout.mouseBtnX;
        lTargetY = layout.mouseBtnY + pressOff;
      } else if (leftTyping) {
        lTargetX = this.leftHand.tx;
        lTargetY = this.leftHand.ty;
      } else {
        // Resting politely right in front of her fluffy chest on the keyboard bezel!
        lTargetX = shL.x + 10;
        lTargetY = kbTopRestY;
      }

      if (rightTyping) {
        rTargetX = this.rightHand.tx;
        rTargetY = this.rightHand.ty;
      } else {
        rTargetX = shR.x - 10;
        rTargetY = kbTopRestY;
      }
    }

    const hLerp = 1 - Math.exp(-28 * dt);
    this.leftHand.x += (lTargetX - this.leftHand.x) * hLerp;
    this.leftHand.y += (lTargetY - this.leftHand.y) * hLerp;
    this.rightHand.x += (rTargetX - this.rightHand.x) * hLerp;
    this.rightHand.y += (rTargetY - this.rightHand.y) * hLerp;
    this.leftHand.squash *= Math.exp(-14 * dt);
    this.rightHand.squash *= Math.exp(-14 * dt);

    const maxMouseReach = layout.is108 ? 116 : 102;
    if (awakeAlpha > 0.01) {
      ctx.save();
      ctx.globalAlpha = awakeAlpha;
      this.drawUnifiedFluffyPaw(
        ctx,
        shL.x,
        shL.y,
        this.leftHand.x,
        this.leftHand.y,
        'left',
        this.leftHand.squash,
        layout.privacyMode ? 168 : mouseMode ? maxMouseReach : 96,
        showToeBeans,
      );
      this.drawUnifiedFluffyPaw(
        ctx,
        shR.x,
        shR.y,
        this.rightHand.x,
        this.rightHand.y,
        'right',
        this.rightHand.squash,
        layout.privacyMode ? 168 : mouseMode ? 96 : 96,
        showToeBeans,
      );

      // Drape Xiaonian's lush fluffy chest bib ("口水兜") OVER the upper arms so the paws emerge naturally from beneath her fur!
      if (!layout.privacyMode && !isPetted && this.baseImg.complete && this.baseImg.naturalWidth > 0) {
        this.renderFluffyChestBibOverlay(ctx, now, g);
      }
      ctx.restore();
    }

    // 4) Original hand-drawn Xiaonian sticker FX particles (anger 💢 / heart / star / blue Zzz)
    for (const p of this.particles) {
      const fxImg = this.fx[p.kind];
      if (!fxImg || !fxImg.complete || fxImg.naturalWidth <= 0) continue;
      ctx.save();
      const fadeIn = Math.min(1, (1 - p.life) * 5.0);
      const fadeOut = Math.min(1, p.life * 2.2);
      ctx.globalAlpha = Math.max(0, Math.min(1, fadeIn * fadeOut));
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      const baseSize = p.kind === 'anger' ? 28 : p.kind === 'zzz' ? 24 : 25;
      const aspect = fxImg.naturalWidth / fxImg.naturalHeight;
      const pop =
        p.kind === 'zzz'
          ? 0.55 + (1 - p.life) * 0.72
          : 0.85 + Math.sin(Math.min(1, (1 - p.life) * 3) * Math.PI * 0.5) * 0.22;
      const dw = baseSize * p.scale * pop * aspect;
      const dh = baseSize * p.scale * pop;
      ctx.drawImage(fxImg, -dw * 0.5, -dh * 0.5, dw, dh);
      ctx.restore();
    }
  }

  /**
   * Re-renders only Xiaonian's lush fluffy chest ruff/bib ("口水兜") from `xiaonian_base.png`
   * over the upper arms using a multi-tuft feathery fur contour so her paws peek out from beneath her chest fur!
   */
  private renderFluffyChestBibOverlay(
    ctx: CanvasRenderingContext2D,
    now: number,
    g: {
      baseW: number;
      baseH: number;
      pivotX: number;
      pivotY: number;
      totalTilt: number;
    },
  ): void {
    const bw = g.baseW;
    const bh = g.baseH;
    const px = (nx: number) => (nx - 0.5) * bw;
    const py = (ny: number) => ny * bh - bh + 24;

    const sqX = 1 + this.bodyBob * 0.028 + Math.sin(now * 0.0034) * 0.009;
    const sqY = 1 - this.bodyBob * 0.024 - Math.sin(now * 0.0034) * 0.008;

    ctx.save();
    ctx.translate(g.pivotX, g.pivotY);
    ctx.rotate(g.totalTilt);
    ctx.scale(sqX, sqY);

    // Feathery jagged fur-tuft bottom contour matching Xiaonian's real chest bib locks (normY 0.48..0.83)
    const traceBibPath = () => {
      ctx.beginPath();
      ctx.moveTo(px(0.14), py(0.49));
      ctx.lineTo(px(0.86), py(0.49));
      ctx.lineTo(px(0.84), py(0.71));
      // Right-to-left soft spiky fur tufts draping over both shoulders and center chest
      ctx.quadraticCurveTo(px(0.80), py(0.76), px(0.74), py(0.79));
      ctx.lineTo(px(0.70), py(0.74));
      ctx.quadraticCurveTo(px(0.66), py(0.80), px(0.61), py(0.82));
      ctx.lineTo(px(0.56), py(0.77));
      ctx.quadraticCurveTo(px(0.52), py(0.83), px(0.49), py(0.84));
      ctx.quadraticCurveTo(px(0.45), py(0.82), px(0.43), py(0.77));
      ctx.quadraticCurveTo(px(0.38), py(0.82), px(0.34), py(0.81));
      ctx.lineTo(px(0.30), py(0.75));
      ctx.quadraticCurveTo(px(0.24), py(0.79), px(0.20), py(0.75));
      ctx.lineTo(px(0.16), py(0.70));
      ctx.closePath();
    };

    // Subtle soft fur shadow cast by the hanging bib onto the upper arms underneath
    ctx.save();
    ctx.translate(0, 2.6);
    traceBibPath();
    ctx.fillStyle = 'rgba(135, 110, 88, 0.14)';
    ctx.fill();
    ctx.restore();

    // Clip to the feathery chest bib contour & stamp exact pixel-matched fur from xiaonian_base.png!
    traceBibPath();
    ctx.clip();
    ctx.drawImage(this.baseImg, -bw * 0.5, -bh + 24, bw, bh);
    ctx.restore();
  }

  /**
   * Renders Xiaonian's real hand-drawn super-fluffy spiky-tufted tail sprite (`xiaonian_tail.png`),
   * smoothly pivoting from her right hip when wagging AND stretching/whipping accurately to slap keys!
   */
  private drawFluffyTailSprite(
    ctx: CanvasRenderingContext2D,
    rootX: number,
    rootY: number,
    layout: DaFeiYuLayout,
  ): void {
    if (!this.tailImg.complete || this.tailImg.naturalWidth <= 0) return;

    const baseW = layout.is108 ? 128 : 118;
    const baseH = baseW * (this.tailImg.naturalHeight / this.tailImg.naturalWidth);
    const rootLocalX = TAIL_ROOT_NX * baseW;
    const rootLocalY = TAIL_ROOT_NY * baseH;
    const natDx = (TAIL_TIP_NX - TAIL_ROOT_NX) * baseW;
    const natDy = (TAIL_TIP_NY - TAIL_ROOT_NY) * baseH;
    const natLen = Math.hypot(natDx, natDy);
    const natAng = Math.atan2(natDy, natDx);

    const targetDx = this.tail.relX;
    const targetDy = this.tail.relY;
    const targetDist = Math.max(40, Math.hypot(targetDx, targetDy));
    const targetAng = Math.atan2(targetDy, targetDx);

    // Blend smoothly from gentle natural wag at rest to exact aimed whip during key slap!
    const slap = this.tail.phase;
    const idleAngle = this.tail.activeWag;
    let deltaAng = targetAng - natAng;
    while (deltaAng > Math.PI) deltaAng -= Math.PI * 2;
    while (deltaAng < -Math.PI) deltaAng += Math.PI * 2;
    const rot = idleAngle * (1 - slap) + deltaAng * slap;

    const slapLenScale = Math.max(0.85, Math.min(1.45, targetDist / natLen));
    const scaleAlong = 1 + (slapLenScale - 1) * slap;
    const scaleWidth = 1 + this.tail.squash * 0.14 - (scaleAlong - 1) * 0.18;

    ctx.save();
    ctx.translate(rootX, rootY);
    ctx.rotate(rot);
    // Align local axis along tail vector for clean stretch/squash, then unrotate back to image space
    ctx.rotate(natAng);
    ctx.scale(scaleAlong, scaleWidth);
    ctx.rotate(-natAng);
    ctx.drawImage(this.tailImg, -rootLocalX, -rootLocalY, baseW, baseH);
    ctx.restore();
  }

  /**
   * Soft, chubby, pillowy snow-white "cloud mitten" cat paws with ZERO sharp spikes or wrist seams —
   * matching Xiaonian's innocent, plush, harmless ("毛绒绒、人畜无害") paws from her sitting & peeking stickers!
   */
  private drawUnifiedFluffyPaw(
    ctx: CanvasRenderingContext2D,
    sx: number,
    sy: number,
    targetX: number,
    targetY: number,
    side: 'left' | 'right',
    squash: number,
    maxLen: number,
    showToeBeans: boolean,
  ): void {
    const dx = targetX - sx;
    const dy = targetY - sy;
    const rawLen = Math.max(1, Math.hypot(dx, dy));
    const len = Math.max(12, Math.min(rawLen, maxLen));
    const ang = Math.atan2(dy, dx);
    const outerSign = side === 'left' ? 1 : -1;

    // Soft plump plushie mitten proportions (chubby, rounded, cloud-like!)
    const rSh = 17.0;
    const rWrist = 14.8;
    const rPaw = 16.4 * (1 + squash * 0.11);
    const pawCenterX = len;
    const tipX = pawCenterX + rPaw * 0.92 * (1 - squash * 0.08);
    const midX = len * 0.50;

    // Smooth, chubby, completely spike-free plushie sleeve seamlessly blooming into a round marshmallow paw!
    const traceCloudPawPath = (closeShoulder: boolean) => {
      const o = outerSign;
      const i = -outerSign;

      ctx.beginPath();
      ctx.moveTo(0, o * rSh);
      // Soft gently curved outer plush sleeve flowing organically into the wide chubby paw cushion
      ctx.bezierCurveTo(
        midX * 0.55,
        o * (rSh + 1.2),
        midX * 1.15,
        o * (rWrist + 1.8),
        pawCenterX - 2,
        o * rPaw,
      );
      // Round pillowy cloud paw tip with ultra-gentle, soft, harmless puff curve
      ctx.bezierCurveTo(
        tipX - 1.5,
        o * (rPaw * 0.96),
        tipX + 1.2,
        o * (rPaw * 0.44),
        tipX + 1.2,
        0,
      );
      ctx.bezierCurveTo(
        tipX + 1.2,
        i * (rPaw * 0.44),
        tipX - 1.5,
        i * (rPaw * 0.96),
        pawCenterX - 2,
        i * rPaw,
      );
      // Soft inner plush sleeve back to chest shoulder
      ctx.bezierCurveTo(
        midX * 1.15,
        i * (rWrist + 0.8),
        midX * 0.55,
        i * (rSh + 0.4),
        0,
        i * rSh,
      );
      if (closeShoulder) {
        ctx.closePath();
      }
    };

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(ang);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Creamy warm-ivory fur at upper arm transitioning smoothly into bright soft snow-white cloud paw
    const armGrad = ctx.createLinearGradient(0, 0, tipX, 0);
    armGrad.addColorStop(0.0, '#f4eadc');
    armGrad.addColorStop(0.45, '#faf5ed');
    armGrad.addColorStop(0.75, '#fffefb');
    armGrad.addColorStop(1.0, '#ffffff');

    traceCloudPawPath(true);
    ctx.fillStyle = armGrad;
    ctx.fill();

    // Soft pillowy warm plush shading along the edges (gives that cozy cotton-puff volume!)
    ctx.save();
    traceCloudPawPath(true);
    ctx.clip();
    const softShade = ctx.createRadialGradient(
      pawCenterX - 2,
      -outerSign * 3,
      3,
      pawCenterX,
      0,
      rPaw * 1.55,
    );
    softShade.addColorStop(0.0, 'rgba(255, 255, 255, 0.45)');
    softShade.addColorStop(0.68, 'rgba(244, 232, 218, 0.0)');
    softShade.addColorStop(1.0, 'rgba(218, 198, 176, 0.34)');
    ctx.fillStyle = softShade;
    ctx.fillRect(-6, -rSh - 8, tipX + 16, (rSh + 8) * 2);
    ctx.restore();

    // Clean warm dark-brown sticker outline (open at shoulder so it tucks softly beneath the chest bib!)
    ctx.strokeStyle = OUTLINE_COLOR;
    ctx.lineWidth = 3.4;
    traceCloudPawPath(false);
    ctx.stroke();

    // Soft cream blend at shoulder root
    ctx.fillStyle = '#f6efe4';
    ctx.beginPath();
    ctx.arc(-1, 0, rSh * 0.85, 0, Math.PI * 2);
    ctx.fill();

    if (!showToeBeans) {
      // Ultra-soft, harmless pale-taupe toe dimples (NO harsh dark claw lines!)
      ctx.strokeStyle = '#c4b19d';
      ctx.lineWidth = 1.9;
      ctx.beginPath();
      ctx.moveTo(tipX - 5.2, -rPaw * 0.34);
      ctx.lineTo(tipX - 1.2, -rPaw * 0.36);
      ctx.moveTo(tipX - 5.2, rPaw * 0.34);
      ctx.lineTo(tipX - 1.2, rPaw * 0.36);
      ctx.stroke();
    } else {
      // Adorable rosy pink main pad + 3 tiny pink toe beans matching Xiaonian's belly-up sticker!
      ctx.fillStyle = '#f8a5b2';
      ctx.beginPath();
      ctx.ellipse(pawCenterX - 1.5, 0, 5.2, 6.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(pawCenterX + 6.0, -5.6, 2.5, 0, Math.PI * 2);
      ctx.arc(pawCenterX + 7.6, 0, 2.6, 0, Math.PI * 2);
      ctx.arc(pawCenterX + 6.0, 5.6, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }
}
