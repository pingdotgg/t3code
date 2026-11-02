/**
 * niri's spring (src/animation/spring.rs), itself libadwaita's: a damped
 * harmonic oscillator of mass 1 moving from `from` to `to`. Times are in
 * seconds of animation time.
 */
export interface SpringParams {
  /** 1 is critically damped: the fastest settle with no overshoot. Below 1 bounces. */
  readonly dampingRatio: number;
  readonly stiffness: number;
  /** How close to `to` counts as settled, in the animated value's units. */
  readonly epsilon: number;
}

/** f32::EPSILON, which niri uses to tell a critically damped spring apart. */
const CRITICAL_EPSILON = 1.1920929e-7;

export class Spring {
  private readonly damping: number;
  private readonly stiffness: number;

  constructor(
    readonly from: number,
    readonly to: number,
    /** Units per second of animation time. */
    readonly initialVelocity: number,
    readonly params: SpringParams,
  ) {
    this.stiffness = Math.max(0, params.stiffness);
    this.damping = Math.max(0, params.dampingRatio) * 2 * Math.sqrt(this.stiffness);
  }

  /** Where the spring is `t` seconds in. */
  valueAt(t: number): number {
    const beta = this.damping / 2;
    const omega0 = Math.sqrt(this.stiffness);
    const x0 = this.from - this.to;
    const v0 = this.initialVelocity;
    const envelope = Math.exp(-beta * t);
    if (Math.abs(beta - omega0) <= CRITICAL_EPSILON) {
      return this.to + envelope * (x0 + (beta * x0 + v0) * t);
    }
    if (beta < omega0) {
      const omega1 = Math.sqrt(omega0 * omega0 - beta * beta);
      return (
        this.to +
        envelope * (x0 * Math.cos(omega1 * t) + ((beta * x0 + v0) / omega1) * Math.sin(omega1 * t))
      );
    }
    const omega2 = Math.sqrt(beta * beta - omega0 * omega0);
    return (
      this.to +
      envelope * (x0 * Math.cosh(omega2 * t) + ((beta * x0 + v0) / omega2) * Math.sinh(omega2 * t))
    );
  }

  /**
   * Seconds until the spring is at rest. Critical and underdamped springs
   * use the envelope (amplitude independent); overdamped ones refine it
   * with Newton's method on the oscillation itself.
   */
  duration(): number {
    const delta = 0.001;
    const beta = this.damping / 2;
    if (beta <= Number.EPSILON) return Number.POSITIVE_INFINITY;
    if (Math.abs(this.to - this.from) <= Number.EPSILON) return 0;
    const omega0 = Math.sqrt(this.stiffness);
    let x0 = -Math.log(this.params.epsilon) / beta;
    if (Math.abs(beta - omega0) <= CRITICAL_EPSILON || beta < omega0) return x0;

    let y0 = this.valueAt(x0);
    let slope = (this.valueAt(x0 + delta) - y0) / delta;
    let x1 = (this.to - y0 + slope * x0) / slope;
    let y1 = this.valueAt(x1);
    for (let i = 0; Math.abs(this.to - y1) > this.params.epsilon; i++) {
      if (i > 1000) return 0;
      x0 = x1;
      y0 = y1;
      slope = (this.valueAt(x0 + delta) - y0) / delta;
      x1 = (this.to - y0 + slope * x0) / slope;
      y1 = this.valueAt(x1);
      if (!Number.isFinite(y1)) return x0;
    }
    return x1;
  }

  /** Seconds until the spring first comes within epsilon of `to`, in 1ms steps. */
  clampedDuration(): number | null {
    const beta = this.damping / 2;
    if (beta <= Number.EPSILON) return Number.POSITIVE_INFINITY;
    if (Math.abs(this.to - this.from) <= Number.EPSILON) return 0;
    const rising = this.to - this.from > Number.EPSILON;
    let ms = 1;
    let y = this.valueAt(ms / 1000);
    while (rising ? this.to - y > this.params.epsilon : y - this.to > this.params.epsilon) {
      if (ms > 3000) return null;
      ms += 1;
      y = this.valueAt(ms / 1000);
    }
    return ms / 1000;
  }
}
