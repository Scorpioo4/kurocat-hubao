import headUrl from './assets/hubao_live2d/live2d_head.png';
import bodyUrl from './assets/hubao_live2d/live2d_body.png';
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

const OUTLINE_COLOR = '#2d1c12';

/**
 * Full Live2D-style animated companion renderer for Hubao (虎宝) in the user's hand-drawn sticker style:
 * - Separated hand-drawn sticker head (`live2d_head.png`) + armless mochi body (`live2d_body.png`)
 * - Independent spring-physics head tilt, bobbing, and 2.5D face parallax
 * - Real-time mouse & keycap-tracking sparkling green eyes with natural blinking
 * - Smooth grumpy half-closed eyelids + pouting mouth + original blue sigh puffs whenever typing!
 * - Joyful curved laughing eyes + open smile + raised pink-toe-bean cheering paws + purring when petted!
 * - One single unified pair of thick-outline cream-to-white-sock paws seamlessly grown from the shoulders
 *   (idle tucked politely -> typing keycaps -> holding mouse -> raised cheering -> covering eyes on password)
 * - Plush thick-outline cream tail wagging naturally and slapping Enter/Space keys!
 */
export class HubaoRenderer {
  private headImg: HTMLImageElement;
  private bodyImg: HTMLImageElement;
  private fx: Record<'sigh' | 'heart' | 'star', HTMLImageElement>;

  private lastKeyAt = -10000;
  private lastKeyGazeAt = -10000;
  private lastKeyPtX = 214;
  private lastKeyPtY = 353;
  private lastMouseClickAt = -10000;
  private grumpyUntil = -10000;
  private lastSighAt = -10000;
  private keyTimes: number[] = [];
  private typingHeat = 0;

  // Smooth expression blend weights (0..1)
  private grumpyAmount = 0;
  private happyAmount = 0;
  private privacyAmount = 0;
  private blinkAmount = 0;
  private nextBlinkAt = performance.now() + 2800 + Math.random() * 2400;
  private blinkPhase = -1; // -1 = not blinking, 0..1 = blinking curve

  // Live2D eye gaze (-1..1 normalized) & 2.5D head/face motion
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
    relX: 64,
    relY: -36,
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
    this.headImg = mk(headUrl);
    this.bodyImg = mk(bodyUrl);
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
    this.lastKeyGazeAt = now;
    this.lastKeyPtX = pt.x;
    this.lastKeyPtY = pt.y;
    this.grumpyUntil = now + 1500;
    this.keyTimes.push(now);
    this.bodyBob = Math.min(1.1, this.bodyBob + 0.72);

    if (wasIdle || now - this.lastSighAt > Math.max(680, 1500 - this.typingHeat * 800)) {
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

  private spawnSighPuff(layout: DaFeiYuLayout, now: number, force: boolean): void {
    if (!force && now - this.lastSighAt < 550) return;
    this.lastSighAt = now;
    const charX = (layout.is108 ? 268 : 196) + this.bodyShiftX;
    this.particles.push({
      x: charX + (Math.random() > 0.5 ? 1 : -1) * (16 + Math.random() * 24),
      y: 88 + (Math.random() - 0.5) * 14,
      vx: (Math.random() - 0.5) * 0.6,
      vy: -0.9 - Math.random() * 0.5,
      life: 1,
      scale: 0.72 + Math.random() * 0.22,
      rot: (Math.random() - 0.5) * 0.26,
      vrot: (Math.random() - 0.5) * 0.014,
      kind: 'sigh',
    });
  }

  private spawnJoyParticle(x: number, y: number): void {
    const isHeart = Math.random() > 0.42;
    this.particles.push({
      x: x + (Math.random() - 0.5) * 95,
      y: y + (Math.random() - 0.5) * 24,
      vx: (Math.random() - 0.5) * 0.75,
      vy: -1.0 - Math.random() * 0.85,
      life: 1,
      scale: isHeart ? 0.68 + Math.random() * 0.24 : 0.64 + Math.random() * 0.26,
      rot: (Math.random() - 0.5) * 0.25,
      vrot: (Math.random() - 0.5) * 0.02,
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

    // Smooth expression weight blending (silky Live2D transitions!)
    const wantGrumpy = isWorking ? 1 : 0;
    const wantHappy = isPetted ? 1 : 0;
    const wantPrivacy = layout.privacyMode ? 1 : 0;
    this.grumpyAmount += (wantGrumpy - this.grumpyAmount) * (1 - Math.exp(-(wantGrumpy ? 18 : 6.5) * dt));
    this.happyAmount += (wantHappy - this.happyAmount) * (1 - Math.exp(-13 * dt));
    this.privacyAmount += (wantPrivacy - this.privacyAmount) * (1 - Math.exp(-14 * dt));

    // Smooth natural blinking (sinusoidal close-open curve)
    if (this.blinkPhase < 0 && now >= this.nextBlinkAt && !isPetted && !layout.privacyMode) {
      this.blinkPhase = 0;
    }
    if (this.blinkPhase >= 0) {
      this.blinkPhase += dt * 7.2; // ~140ms crisp blink
      if (this.blinkPhase >= 1) {
        this.blinkPhase = -1;
        this.blinkAmount = 0;
        this.nextBlinkAt = now + 3100 + Math.random() * 2900;
      } else {
        this.blinkAmount = Math.sin(this.blinkPhase * Math.PI);
      }
    } else {
      this.blinkAmount = 0;
    }

    // Typing heat for sigh frequency
    while (this.keyTimes.length && now - this.keyTimes[0] > 2600) {
      this.keyTimes.shift();
    }
    const typingCPS = this.keyTimes.length / 2.6;
    const heatTarget = layout.privacyMode ? 0 : Math.min(1, Math.max(0, (typingCPS - 1.4) / 4.5));
    this.typingHeat +=
      (heatTarget - this.typingHeat) * (1 - Math.exp(-(heatTarget > this.typingHeat ? 2.6 : 0.85) * dt));

    const charX = layout.is108 ? 268 : 196;
    if (isPetted && Math.random() < 0.085) {
      this.spawnJoyParticle(charX + this.bodyShiftX, 102);
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

    // Live2D Eye Gaze (tracks BOTH global mouse cursor 360° AND active keycaps!)
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
      // Look right down at the keycap Hubao is grumpily pounding!
      const g = this.computeGeom(now, layout);
      const dx = this.lastKeyPtX - g.headCenterX;
      const dy = this.lastKeyPtY - g.headCenterY;
      gazeTx = Math.max(-1, Math.min(1, dx / 95));
      gazeTy = Math.max(0.15, Math.min(1, dy / 145));
    } else if (recentMouseMove) {
      // Silky 360° cursor eye tracking across the entire desktop!
      gazeTx = mxNorm;
      gazeTy = myNorm;
    } else {
      // Gentle idle curiosity micro-look
      gazeTx = Math.sin(now * 0.0009) * 0.25;
      gazeTy = Math.cos(now * 0.0007) * 0.12;
    }

    const gazeRate = activeKeyGaze || recentMouseMove ? 18 : 6.5;
    const gazeLerp = 1 - Math.exp(-gazeRate * dt);
    this.eyeGazeX += (gazeTx - this.eyeGazeX) * gazeLerp;
    this.eyeGazeY += (gazeTy - this.eyeGazeY) * gazeLerp;

    // Independent Live2D Head Tilt & Nod! (Head genuinely tilts & turns toward mouse/keys!)
    if (layout.privacyMode) {
      this.headTiltTarget = Math.sin(now * 0.0055) * 0.06;
    } else if (isPetted) {
      // Blissful happy head sway when getting pets!
      this.headTiltTarget = Math.sin(now * 0.0115) * 0.14;
    } else if (activeKeyGaze) {
      // Grumpy typing head rock following the keystrokes!
      const keyBias = Math.max(-1, Math.min(1, (this.lastKeyPtX - layout.kbCenterX) / (layout.kbWidth * 0.45)));
      this.headTiltTarget = keyBias * 0.13 + Math.sin(now * 0.009) * 0.025;
    } else {
      // Curious adorable head tilt following mouse left/right!
      this.headTiltTarget = this.eyeGazeX * 0.11 + Math.sin(now * 0.0018) * 0.022;
    }
    const hTiltAcc = (this.headTiltTarget - this.headTilt) * 145 - this.headTiltVel * 15;
    this.headTiltVel += hTiltAcc * dt;
    this.headTilt += this.headTiltVel * dt;

    // Head lowers slightly forward when grumpily hunching over the keyboard!
    const targetNodY =
      this.grumpyAmount * 11.5 +
      this.eyeGazeY * 4.5 +
      this.bodyBob * 4.2 -
      this.happyAmount * 3.5;
    this.headNodY += (targetNodY - this.headNodY) * (1 - Math.exp(-14 * dt));

    // Fluffy thick-outline tail physics anchored to lower right hip
    const gTail = this.computeGeom(now, layout);
    const tailRoot = gTail.bodyPointToWorld(0.76, 0.72);
    const wagSpeed = isPetted
      ? 0.014
      : isWorking
        ? 0.011 + this.typingHeat * 0.005
        : 0.0042;
    const idleWag = Math.sin(now * wagSpeed) * (isPetted ? 0.34 : 0.18 + this.typingHeat * 0.14);
    const maxIdleOffX = Math.max(46, Math.min(72, layout.logicalW - 24 - tailRoot.x));
    const idleOffX = maxIdleOffX + Math.sin(now * wagSpeed) * 9;
    const idleOffY = -36 + Math.cos(now * wagSpeed * 1.15) * 7;

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
    this.tail.activeWag = idleWag * (1 - this.tail.phase) + -0.06 * this.tail.phase;

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

  private computeGeom(now: number, layout: DaFeiYuLayout) {
    const charX = layout.is108 ? 268 : 196;
    const kbTopEdge = layout.kbCenterY - layout.kbHeight * 0.34;
    const breath = Math.sin(now * 0.0034) * 2.0 + this.bodyBob * 3.0 + this.bodyDiveY;
    const bodyW = layout.is108 ? 168 : 160;
    const bodyH = bodyW * (460 / 457);
    const headW = layout.is108 ? 228 : 218;
    const headH = headW * (385 / 520);

    const bodyPivotX = charX + this.bodyShiftX;
    const bodyBaseY = kbTopEdge + 54 + breath;
    const bodyPivotY = bodyBaseY - 36;

    const bodyPointToWorld = (normX: number, normY: number) => {
      const lx = (normX - 0.5) * bodyW;
      const ly = normY * bodyH - bodyH + 36;
      const c = Math.cos(this.bodyTilt);
      const s = Math.sin(this.bodyTilt);
      return {
        x: bodyPivotX + lx * c - ly * s,
        y: bodyPivotY + lx * s + ly * c,
      };
    };

    // Neck pivot sits organically at the upper-center of the armless torso
    const neckWorld = bodyPointToWorld(0.5, 0.14);
    const totalHeadTilt = this.bodyTilt * 0.55 + this.headTilt;
    const headAnchorX = neckWorld.x + this.eyeGazeX * 3.5;
    const headAnchorY = neckWorld.y + 8 + this.headNodY;
    // Head center in world coordinates (for eye gaze direction & privacy paw targets)
    const headCenterOffsetY = -headH * 0.38;
    const hc = Math.cos(totalHeadTilt);
    const hs = Math.sin(totalHeadTilt);
    const headCenterX = headAnchorX - headCenterOffsetY * hs;
    const headCenterY = headAnchorY + headCenterOffsetY * hc;

    const headPointToWorld = (normX: number, normY: number) => {
      const lx = (normX - 0.5) * headW;
      // Head image bottom aligns slightly below neck pivot (normY = 0.88 at pivot) so chin overlaps neck seamlessly!
      const ly = (normY - 0.88) * headH;
      return {
        x: headAnchorX + lx * hc - ly * hs,
        y: headAnchorY + lx * hs + ly * hc,
      };
    };

    return {
      bodyW,
      bodyH,
      bodyPivotX,
      bodyPivotY,
      headW,
      headH,
      headAnchorX,
      headAnchorY,
      headCenterX,
      headCenterY,
      totalHeadTilt,
      bodyPointToWorld,
      headPointToWorld,
    };
  }

  /** Layer 1 (BEFORE keyboard & mouse): fluffy sticker tail back + armless body + rotating Live2D head & face! */
  public renderBody(ctx: CanvasRenderingContext2D, now: number, layout: DaFeiYuLayout): void {
    const g = this.computeGeom(now, layout);

    // 1) Thick-outline sticker cat tail emerging naturally behind right hip!
    const tailRoot = g.bodyPointToWorld(0.76, 0.72);
    const tipX = tailRoot.x + this.tail.relX;
    const tipY = tailRoot.y + this.tail.relY;
    this.drawStickerTail(
      ctx,
      tailRoot.x,
      tailRoot.y,
      tipX,
      tipY,
      this.tail.phase,
      this.tail.activeWag,
      layout.logicalW,
      'back',
    );

    ctx.save();
    // Clip cleanly along the top edge of the keyboard so lower torso rests neatly behind it
    ctx.beginPath();
    ctx.rect(0, 0, layout.logicalW, layout.kbCenterY - layout.kbHeight * 0.28);
    ctx.clip();

    // 2) Armless mochi torso with gentle breathing squash-and-stretch
    if (this.bodyImg.complete && this.bodyImg.naturalWidth > 0) {
      ctx.save();
      ctx.translate(g.bodyPivotX, g.bodyPivotY);
      ctx.rotate(this.bodyTilt);
      ctx.scale(1 + this.bodyBob * 0.026, 1 - this.bodyBob * 0.022);
      ctx.drawImage(this.bodyImg, -g.bodyW * 0.5, -g.bodyH + 36, g.bodyW, g.bodyH);
      ctx.restore();
    }

    // 3) Independently rotating, bobbing Live2D Hubao head + dynamic mouse-tracking eyes & mouth!
    if (this.headImg.complete && this.headImg.naturalWidth > 0) {
      ctx.save();
      ctx.translate(g.headAnchorX, g.headAnchorY);
      ctx.rotate(g.totalHeadTilt);
      const hSqX = 1 + this.bodyBob * 0.024;
      const hSqY = 1 - this.bodyBob * 0.020;
      ctx.scale(hSqX, hSqY);

      // Draw hand-drawn sticker head base (ears, crayon fur, whiskers, blushes, pink nose!)
      ctx.drawImage(this.headImg, -g.headW * 0.5, -g.headH * 0.88, g.headW, g.headH);

      // Draw Live2D animated green eyes, grumpy typing eyelids, happy laughing eyes, and mouth!
      this.renderLiveFace(ctx, g.headW, g.headH);
      ctx.restore();
    }

    ctx.restore();
  }

  /**
   * Draws Live2D mouse-tracking green eyes, blinking, grumpy typing half-closed eyelids (sticker #4),
   * happy laughing curved eyes + open smile (sticker #3), and surprised mouth (sticker #1) in head-local space!
   */
  private renderLiveFace(ctx: CanvasRenderingContext2D, headW: number, headH: number): void {
    // 2.5D face parallax shift as Hubao looks around at mouse or keycaps!
    const faceShiftX = this.eyeGazeX * 5.2;
    const faceShiftY = this.eyeGazeY * 3.0;

    // Eye socket centers aligned precisely above the pink blushes on live2d_head.png (520x385)
    const eyeSpanX = headW * 0.148;
    const eyeCenterY = (0.515 - 0.88) * headH + faceShiftY * 0.55;
    const eyeRx = headW * 0.086;
    const eyeRy = headW * 0.089;

    const showHappyFace = this.happyAmount > 0.35;

    // 1) EYES
    for (const side of [-1, 1] as const) {
      const ecx = side * eyeSpanX + faceShiftX * 0.65;
      const ecy = eyeCenterY;

      if (showHappyFace) {
        // Sticker #3: joyful thick curved laughing eyes ⌒ ⌒
        ctx.save();
        ctx.strokeStyle = OUTLINE_COLOR;
        ctx.lineWidth = 4.5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(ecx, ecy + eyeRy * 0.35, eyeRx * 0.82, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      if (this.blinkAmount > 0.82) {
        // Closed gentle blink arc ◡
        ctx.save();
        ctx.strokeStyle = OUTLINE_COLOR;
        ctx.lineWidth = 3.8;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(ecx, ecy - eyeRy * 0.1, eyeRx * 0.78, Math.PI * 0.14, Math.PI * 0.86);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      // Open / grumpy-half-closed sparkling green sticker eyes!
      ctx.save();
      const openScaleY = Math.max(0.18, 1 - this.blinkAmount * 0.85);
      ctx.translate(ecx, ecy);
      ctx.scale(1, openScaleY);

      // Clip inside exact round eye socket
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(0, 0, eyeRx, eyeRy, 0, 0, Math.PI * 2);
      ctx.clip();

      // Fresh sage-green iris matching Hubao's real eyes & hand-drawn stickers!
      const irisGrad = ctx.createRadialGradient(0, eyeRy * 0.25, 2, 0, 0, eyeRx * 1.15);
      irisGrad.addColorStop(0.0, '#cfe6a6');
      irisGrad.addColorStop(0.55, '#95be72');
      irisGrad.addColorStop(1.0, '#6a904c');
      ctx.fillStyle = irisGrad;
      ctx.fillRect(-eyeRx - 2, -eyeRy - 2, eyeRx * 2 + 4, eyeRy * 2 + 4);

      // Huge glossy dark pupil tracking mouse & keycaps smoothly 360°!
      const px = this.eyeGazeX * (eyeRx * 0.36);
      const py = this.eyeGazeY * (eyeRy * 0.34);
      const pupilRx = eyeRx * 0.67;
      const pupilRy = eyeRy * 0.70;

      ctx.fillStyle = '#181412';
      ctx.beginPath();
      ctx.ellipse(px, py, pupilRx, pupilRy, 0, 0, Math.PI * 2);
      ctx.fill();

      // Subtle glossy olive rim highlight at bottom of pupil
      ctx.strokeStyle = 'rgba(208, 234, 158, 0.38)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(px, py + 0.5, pupilRx * 0.82, Math.PI * 0.18, Math.PI * 0.82);
      ctx.stroke();

      // Crisp sparkling white eye catchlights (big main + cute secondary)
      const hlX = px - pupilRx * 0.32;
      const hlY = py - pupilRy * 0.34;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(hlX, hlY, eyeRx * 0.24, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
      ctx.beginPath();
      ctx.arc(px + pupilRx * 0.34, py + pupilRy * 0.30, eyeRx * 0.10, 0, Math.PI * 2);
      ctx.fill();

      // GRUMPY TYPING EYELID (Sticker #4!): flat slightly-angled cream fur eyelid drops smoothly
      // over the upper half of both eyes when Hubao is forced to work on the keyboard!
      if (this.grumpyAmount > 0.03) {
        const lidDrop = -eyeRy * 1.05 + this.grumpyAmount * (eyeRy * 1.08);
        const tiltDelta = side * (-eyeRy * 0.18 * this.grumpyAmount); // inner corner slightly lower = super grumpy cute!
        const yOuter = lidDrop - tiltDelta;
        const yInner = lidDrop + tiltDelta;
        const xL = -eyeRx - 3;
        const xR = eyeRx + 3;
        const yL = side === -1 ? yOuter : yInner;
        const yR = side === -1 ? yInner : yOuter;

        // Fill upper eyelid with matching pale vanilla-cream fur
        ctx.fillStyle = '#f6e4cc';
        ctx.beginPath();
        ctx.moveTo(xL, -eyeRy - 4);
        ctx.lineTo(xR, -eyeRy - 4);
        ctx.lineTo(xR, yR);
        ctx.lineTo(xL, yL);
        ctx.closePath();
        ctx.fill();

        // Thick dark-chocolate-brown grumpy upper eyelid line!
        ctx.strokeStyle = OUTLINE_COLOR;
        ctx.lineWidth = 3.8;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(xL, yL);
        ctx.lineTo(xR, yR);
        ctx.stroke();
      }

      ctx.restore(); // end eye clip

      // Crisp dark-chocolate-brown round eye border
      ctx.strokeStyle = OUTLINE_COLOR;
      ctx.lineWidth = 3.1;
      ctx.beginPath();
      ctx.ellipse(0, 0, eyeRx, eyeRy, 0, 0, Math.PI * 2);
      ctx.stroke();

      // Re-stroke grumpy flat brow overhang slightly outside rim for authentic sticker #4 punch!
      if (this.grumpyAmount > 0.12) {
        const lidDrop = -eyeRy * 1.05 + this.grumpyAmount * (eyeRy * 1.08);
        const tiltDelta = side * (-eyeRy * 0.18 * this.grumpyAmount);
        const yL = side === -1 ? lidDrop - tiltDelta : lidDrop + tiltDelta;
        const yR = side === -1 ? lidDrop + tiltDelta : lidDrop - tiltDelta;
        ctx.strokeStyle = OUTLINE_COLOR;
        ctx.lineWidth = 3.6;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-eyeRx * 0.98, yL);
        ctx.lineTo(eyeRx * 0.98, yR);
        ctx.stroke();
      }

      ctx.restore();
    }

    // 2) DYNAMIC MOUTH (aligned right beneath the pink triangle nose at normY = 0.625)
    const mouthX = faceShiftX * 0.42;
    const mouthY = (0.642 - 0.88) * headH + faceShiftY * 0.30;

    ctx.save();
    ctx.translate(mouthX, mouthY);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (this.privacyAmount > 0.35) {
      // Sticker #1: adorable surprised oval 'O' mouth with pink tongue!
      ctx.fillStyle = '#c84b58';
      ctx.strokeStyle = OUTLINE_COLOR;
      ctx.lineWidth = 3.0;
      ctx.beginPath();
      ctx.ellipse(0, 11, 7.2, 10.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ff98a4';
      ctx.beginPath();
      ctx.ellipse(0, 15.2, 4.6, 4.8, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (showHappyFace) {
      // Sticker #3: joyful laughing cat mouth with open rosy tongue!
      ctx.fillStyle = '#cf4d5b';
      ctx.strokeStyle = OUTLINE_COLOR;
      ctx.lineWidth = 3.0;
      ctx.beginPath();
      ctx.moveTo(-8.5, 4);
      ctx.quadraticCurveTo(0, 22, 8.5, 4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ff9aa8';
      ctx.beginPath();
      ctx.ellipse(0, 11.5, 4.5, 3.8, 0, 0, Math.PI * 2);
      ctx.fill();

      // Cute cat upper lip 'w' curve
      ctx.strokeStyle = OUTLINE_COLOR;
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(-11, 2.5);
      ctx.quadraticCurveTo(-5.5, 7.5, 0, 2.2);
      ctx.quadraticCurveTo(5.5, 7.5, 11, 2.5);
      ctx.stroke();
    } else {
      // Sticker #2 & #4: classic goofy / grumpy inverted-V '人' cat mouth!
      const poutExtra = this.grumpyAmount * 2.4;
      ctx.strokeStyle = OUTLINE_COLOR;
      ctx.lineWidth = 3.3;
      ctx.beginPath();
      ctx.moveTo(0, -1.5);
      ctx.lineTo(0, 3.5);
      ctx.moveTo(-7.2 - poutExtra * 0.4, 9.2 + poutExtra);
      ctx.quadraticCurveTo(-3.2, 5.2, 0, 3.5);
      ctx.quadraticCurveTo(3.2, 5.2, 7.2 + poutExtra * 0.4, 9.2 + poutExtra);
      ctx.stroke();
    }

    ctx.restore();
  }

  /** Layer 2 (AFTER keyboard & mouse): unified thick-outline paws, slapping tail tip & original sticker FX! */
  public renderForeground(
    ctx: CanvasRenderingContext2D,
    dt: number,
    now: number,
    layout: DaFeiYuLayout,
  ): void {
    const g = this.computeGeom(now, layout);
    const shL = g.bodyPointToWorld(0.24, 0.42);
    const shR = g.bodyPointToWorld(0.76, 0.42);
    const tailRoot = g.bodyPointToWorld(0.76, 0.72);

    const isPetted = !layout.privacyMode && layout.petEnergy > 0.25;
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

    // 2) Front half of fluffy thick-outline tail while slapping a key
    if (this.tail.phase > 0.12) {
      const tipX = tailRoot.x + this.tail.relX;
      const tipY = tailRoot.y + this.tail.relY;
      this.drawStickerTail(
        ctx,
        tailRoot.x,
        tailRoot.y,
        tipX,
        tipY,
        this.tail.phase,
        this.tail.activeWag,
        layout.logicalW,
        'front',
      );
    }

    // 3) ONE SINGLE UNIFIED PAIR OF PAWS seamlessly attached to the armless torso!
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
      // Raise both white paws to cover Hubao's huge green eyes!
      const eyeL = g.headPointToWorld(0.35, 0.52);
      const eyeR = g.headPointToWorld(0.65, 0.52);
      const shyBob = Math.sin(now * 0.008) * 1.4;
      lTargetX = eyeL.x;
      lTargetY = eyeL.y + shyBob;
      rTargetX = eyeR.x;
      rTargetY = eyeR.y - shyBob;
      showToeBeans = true;
    } else if (isPetted) {
      // Sticker #3: raise BOTH paws joyfully up-outward showing cute pink toe-beans!
      const wave = Math.sin(now * 0.015) * 7.5;
      lTargetX = shL.x - 42;
      lTargetY = shL.y - 26 + wave;
      rTargetX = shR.x + 42;
      rTargetY = shR.y - 26 - wave;
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
        // Resting politely on the keyboard bezel (seamless single set of paws!)
        lTargetX = shL.x + 12;
        lTargetY = kbTopRestY;
      }

      if (rightTyping) {
        rTargetX = this.rightHand.tx;
        rTargetY = this.rightHand.ty;
      } else {
        rTargetX = shR.x - 12;
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

    const maxMouseReach = layout.is108 ? 108 : 96;
    this.drawUnifiedStickerPaw(
      ctx,
      shL.x,
      shL.y,
      this.leftHand.x,
      this.leftHand.y,
      'left',
      this.leftHand.squash,
      layout.privacyMode ? 128 : mouseMode ? maxMouseReach : 92,
      showToeBeans,
    );
    this.drawUnifiedStickerPaw(
      ctx,
      shR.x,
      shR.y,
      this.rightHand.x,
      this.rightHand.y,
      'right',
      this.rightHand.squash,
      layout.privacyMode ? 128 : mouseMode ? 96 : 92,
      showToeBeans,
    );

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
      const baseSize = p.kind === 'sigh' ? 32 : 25;
      const aspect = fxImg.naturalWidth / fxImg.naturalHeight;
      const pop = 0.85 + Math.sin(Math.min(1, (1 - p.life) * 3) * Math.PI * 0.5) * 0.22;
      const dw = baseSize * p.scale * pop * aspect;
      const dh = baseSize * p.scale * pop;
      ctx.drawImage(fxImg, -dw * 0.5, -dh * 0.5, dw, dh);
      ctx.restore();
    }
  }

  /**
   * Thick dark-chocolate-brown hand-drawn sticker style plush cream cat tail!
   */
  private drawStickerTail(
    ctx: CanvasRenderingContext2D,
    rootX: number,
    rootY: number,
    tipX: number,
    tipY: number,
    slapPhase: number,
    wagAngle: number,
    logicalW: number,
    layer: 'back' | 'front',
  ): void {
    const idleCtrlX = rootX + 46;
    const idleCtrlY = rootY - 4;
    const crossLeft = Math.max(0, Math.min(1, (rootX + 24 - tipX) / 145));
    const nearSlapCtrlX = Math.min(logicalW - 18, Math.max(rootX + 82, tipX + 38));
    const nearSlapCtrlY = Math.min(rootY - 42, (rootY + tipY) * 0.5 - 58);
    const farSlapCtrlX = Math.min(logicalW - 16, rootX + 92);
    const farSlapCtrlY = Math.max(rootY + 24, tipY - 12);
    const slapCtrlX = nearSlapCtrlX + (farSlapCtrlX - nearSlapCtrlX) * crossLeft;
    const slapCtrlY = nearSlapCtrlY + (farSlapCtrlY - nearSlapCtrlY) * crossLeft;

    const ctrlX = idleCtrlX + (slapCtrlX - idleCtrlX) * slapPhase;
    const ctrlY = idleCtrlY + (slapCtrlY - idleCtrlY) * slapPhase;
    const wagTipX = tipX + Math.sin(wagAngle) * 10 * (1 - slapPhase);
    const wagTipY = tipY - Math.abs(Math.sin(wagAngle)) * 4 * (1 - slapPhase);

    const steps = 16;
    const pts: Array<{ x: number; y: number; nx: number; ny: number; r: number }> = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const omt = 1 - t;
      const x = omt * omt * rootX + 2 * omt * t * ctrlX + t * t * wagTipX;
      const y = omt * omt * rootY + 2 * omt * t * ctrlY + t * t * wagTipY;
      const tx = 2 * omt * (ctrlX - rootX) + 2 * t * (wagTipX - ctrlX);
      const ty = 2 * omt * (ctrlY - rootY) + 2 * t * (wagTipY - ctrlY);
      const len = Math.max(0.001, Math.hypot(tx, ty));
      const nx = -ty / len;
      const ny = tx / len;
      const puff = Math.sin(t * Math.PI);
      const baseR = 11.2 + puff * 5.2 - t * 0.8;
      const sqBoost = t > 0.7 ? 1 + this.tail.squash * 0.15 : 1;
      pts.push({ x, y, nx, ny, r: baseR * sqBoost });
    }

    const startIdx = layer === 'front' ? Math.floor(steps * 0.44) : 0;
    const drawTipCap = layer === 'front' ? true : slapPhase <= 0.12;
    const last = pts[pts.length - 1];
    const tipAng = Math.atan2(wagTipY - ctrlY, wagTipX - ctrlX);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const tailGrad = ctx.createLinearGradient(rootX, rootY, wagTipX, wagTipY);
    tailGrad.addColorStop(0.0, '#edd4b5');
    tailGrad.addColorStop(0.5, '#f6e4cc');
    tailGrad.addColorStop(1.0, '#ebd0ae');

    ctx.beginPath();
    ctx.moveTo(
      pts[startIdx].x + pts[startIdx].nx * pts[startIdx].r,
      pts[startIdx].y + pts[startIdx].ny * pts[startIdx].r,
    );
    for (let i = startIdx + 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x + pts[i].nx * pts[i].r, pts[i].y + pts[i].ny * pts[i].r);
    }
    if (drawTipCap) {
      ctx.arc(last.x, last.y, last.r, tipAng + Math.PI / 2, tipAng - Math.PI / 2, true);
    } else {
      ctx.lineTo(last.x - last.nx * last.r, last.y - last.ny * last.r);
    }
    for (let i = pts.length - 1; i >= startIdx; i--) {
      ctx.lineTo(pts[i].x - pts[i].nx * pts[i].r, pts[i].y - pts[i].ny * pts[i].r);
    }
    ctx.closePath();

    ctx.fillStyle = tailGrad;
    ctx.fill();

    // Thick dark-chocolate-brown hand-drawn sticker outline matching live2d_body.png!
    ctx.strokeStyle = OUTLINE_COLOR;
    ctx.lineWidth = 3.8;
    const edgeStart = Math.max(1, startIdx);
    ctx.beginPath();
    for (let i = edgeStart; i < pts.length; i++) {
      const px = pts[i].x + pts[i].nx * pts[i].r;
      const py = pts[i].y + pts[i].ny * pts[i].r;
      if (i === edgeStart) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    if (drawTipCap) {
      ctx.arc(last.x, last.y, last.r, tipAng + Math.PI / 2, tipAng - Math.PI / 2, true);
    }
    for (let i = pts.length - 1; i >= edgeStart; i--) {
      const px = pts[i].x - pts[i].nx * pts[i].r;
      const py = pts[i].y - pts[i].ny * pts[i].r;
      if (i === pts.length - 1 && !drawTipCap) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Unified cream-to-white-sock arm & paw growing seamlessly from the armless mochi torso,
   * styled with the exact thick dark-chocolate-brown sticker outline (#2d1c12)!
   */
  private drawUnifiedStickerPaw(
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
    const len = Math.min(rawLen, maxLen);
    const ux = dx / rawLen;
    const uy = dy / rawLen;
    const px = sx + ux * len;
    const py = sy + uy * len;
    const nx = -uy;
    const ny = ux;
    const ang = Math.atan2(dy, dx);
    const sgn = side === 'left' ? -1 : 1;

    const rSh = 12.6;
    const rPaw = 11.4;
    const midX = (sx + px) * 0.5 + nx * (sgn * 3.0);
    const midY = (sy + py) * 0.5 + ny * (sgn * 3.0);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const armGrad = ctx.createLinearGradient(sx, sy, px, py);
    armGrad.addColorStop(0.0, '#f4dfbf');
    armGrad.addColorStop(0.55, '#f9ecda');
    armGrad.addColorStop(0.80, '#fffdf9');
    armGrad.addColorStop(1.0, '#ffffff');

    // Fill arm + shoulder seamlessly into the torso cream fur
    ctx.beginPath();
    ctx.moveTo(sx + nx * rSh, sy + ny * rSh);
    ctx.quadraticCurveTo(midX + nx * 12.2, midY + ny * 12.2, px + nx * rPaw, py + ny * rPaw);
    ctx.arc(px, py, rPaw, ang + Math.PI / 2, ang - Math.PI / 2, true);
    ctx.quadraticCurveTo(midX - nx * 12.2, midY - ny * 12.2, sx - nx * rSh, sy - ny * rSh);
    ctx.closePath();
    ctx.fillStyle = armGrad;
    ctx.fill();

    // Soft shoulder blend patch so upper arm merges organically with the torso fur (no hard seam!)
    ctx.fillStyle = '#f4dfbf';
    ctx.beginPath();
    ctx.arc(sx, sy, rSh * 0.96, 0, Math.PI * 2);
    ctx.fill();

    // Thick dark-chocolate-brown sticker contour (open at shoulder so it flows straight out of torso!)
    ctx.strokeStyle = OUTLINE_COLOR;
    ctx.lineWidth = 3.7;
    ctx.beginPath();
    ctx.moveTo(sx + nx * rSh, sy + ny * rSh);
    ctx.quadraticCurveTo(midX + nx * 12.2, midY + ny * 12.2, px + nx * rPaw, py + ny * rPaw);
    ctx.arc(px, py, rPaw, ang + Math.PI / 2, ang - Math.PI / 2, true);
    ctx.quadraticCurveTo(midX - nx * 12.2, midY - ny * 12.2, sx - nx * rSh, sy - ny * rSh);
    ctx.stroke();

    // Seamlessly blend shoulder root into torso fur so outline opens cleanly into the body
    ctx.fillStyle = '#f4dfbf';
    ctx.beginPath();
    ctx.arc(sx - ux * 1.5, sy - uy * 1.5, rSh * 0.86, 0, Math.PI * 2);
    ctx.fill();

    // Plump round white sticker paw tip
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ang);
    ctx.scale(1 + squash * 0.16, 1 - squash * 0.11);

    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = OUTLINE_COLOR;
    ctx.lineWidth = 3.6;
    ctx.beginPath();
    ctx.ellipse(1.5, 0, 11.0, 12.0, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    if (!showToeBeans) {
      // Cute sticker-style toe divider ticks
      ctx.strokeStyle = '#4e3729';
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      ctx.moveTo(6.2, -3.6);
      ctx.lineTo(11.0, -4.6);
      ctx.moveTo(6.2, 3.6);
      ctx.lineTo(11.0, 4.6);
      ctx.stroke();
    } else {
      // Sticker #3: adorable pink main pad + 3 tiny pink toe beans!
      ctx.fillStyle = '#f49ca8';
      ctx.beginPath();
      ctx.ellipse(-0.5, 0, 4.2, 5.0, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(5.4, -4.6, 2.0, 0, Math.PI * 2);
      ctx.arc(6.6, 0, 2.1, 0, Math.PI * 2);
      ctx.arc(5.4, 4.6, 2.0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
    ctx.restore();
  }
}
