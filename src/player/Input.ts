/** Keyboard/mouse state with pointer lock and edge-triggered key presses. */
export class Input {
  readonly keys = new Set<string>();
  private pressedQueue = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  buttons = 0;
  private clickQueue = new Set<number>();
  locked = false;
  onLockChange: (locked: boolean) => void = () => {};

  constructor(private el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (!this.keys.has(e.code)) this.pressedQueue.add(e.code);
      this.keys.add(e.code);
      if (['Space', 'Tab', 'F1', 'KeyF'].includes(e.code) || e.code.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    el.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      this.buttons |= 1 << e.button;
      this.clickQueue.add(e.button);
    });
    window.addEventListener('mouseup', (e) => (this.buttons &= ~(1 << e.button)));
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('wheel', (e) => {
      if (this.locked) this.wheel += Math.sign(e.deltaY);
    }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      if (!this.locked) this.buttons = 0;
      this.onLockChange(this.locked);
    });
  }

  lock(): void {
    const p = this.el.requestPointerLock() as unknown as Promise<void> | undefined;
    p?.catch?.(() => {});
  }

  down(code: string): boolean {
    return this.keys.has(code);
  }

  /** True once per physical key press. */
  pressed(code: string): boolean {
    if (this.pressedQueue.has(code)) {
      this.pressedQueue.delete(code);
      return true;
    }
    return false;
  }

  clicked(button: number): boolean {
    if (this.clickQueue.has(button)) {
      this.clickQueue.delete(button);
      return true;
    }
    return false;
  }

  held(button: number): boolean {
    return (this.buttons & (1 << button)) !== 0;
  }

  endFrame(): void {
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.pressedQueue.clear();
    this.clickQueue.clear();
  }
}
