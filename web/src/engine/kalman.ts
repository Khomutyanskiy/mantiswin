// Фильтр Калмана для трекинга рамок в пространстве (x, y, a, h, vx, vy, va, vh):
// центр рамки, соотношение сторон w/h, высота и их скорости. Порт ultralytics KalmanFilterXYAH (через iOS KalmanFilter.swift).

export class Matrix {
  readonly a: Float64Array;
  constructor(readonly rows: number, readonly cols: number, data?: ArrayLike<number>) {
    this.a = data ? Float64Array.from(data) : new Float64Array(rows * cols);
  }

  static identity(n: number): Matrix {
    const m = new Matrix(n, n);
    for (let i = 0; i < n; i++) m.set(i, i, 1);
    return m;
  }

  static diag(v: number[]): Matrix {
    const m = new Matrix(v.length, v.length);
    for (let i = 0; i < v.length; i++) m.set(i, i, v[i]);
    return m;
  }

  get(r: number, c: number): number {
    return this.a[r * this.cols + c];
  }
  set(r: number, c: number, v: number): void {
    this.a[r * this.cols + c] = v;
  }

  t(): Matrix {
    const m = new Matrix(this.cols, this.rows);
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) m.set(c, r, this.get(r, c));
    return m;
  }

  mul(r: Matrix): Matrix {
    const m = new Matrix(this.rows, r.cols);
    for (let i = 0; i < this.rows; i++) {
      for (let k = 0; k < this.cols; k++) {
        const lik = this.get(i, k);
        if (lik === 0) continue;
        for (let j = 0; j < r.cols; j++) m.a[i * r.cols + j] += lik * r.get(k, j);
      }
    }
    return m;
  }

  add(r: Matrix): Matrix {
    const m = new Matrix(this.rows, this.cols, this.a);
    for (let i = 0; i < m.a.length; i++) m.a[i] += r.a[i];
    return m;
  }

  sub(r: Matrix): Matrix {
    const m = new Matrix(this.rows, this.cols, this.a);
    for (let i = 0; i < m.a.length; i++) m.a[i] -= r.a[i];
    return m;
  }

  /** Обратная матрица методом Гаусса — Жордана (для 4×4 ковариации проекции). */
  inverse(): Matrix {
    const n = this.rows;
    const m = new Matrix(n, n, this.a);
    const inv = Matrix.identity(n);
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(m.get(r, col)) > Math.abs(m.get(pivot, col))) pivot = r;
      if (pivot !== col) {
        for (let c = 0; c < n; c++) {
          let tmp = m.a[col * n + c]; m.a[col * n + c] = m.a[pivot * n + c]; m.a[pivot * n + c] = tmp;
          tmp = inv.a[col * n + c]; inv.a[col * n + c] = inv.a[pivot * n + c]; inv.a[pivot * n + c] = tmp;
        }
      }
      const p = m.get(col, col);
      if (Math.abs(p) <= 1e-12) continue;
      for (let c = 0; c < n; c++) {
        m.set(col, c, m.get(col, c) / p);
        inv.set(col, c, inv.get(col, c) / p);
      }
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = m.get(r, col);
        if (f === 0) continue;
        for (let c = 0; c < n; c++) {
          m.set(r, c, m.get(r, c) - f * m.get(col, c));
          inv.set(r, c, inv.get(r, c) - f * inv.get(col, c));
        }
      }
    }
    return inv;
  }
}

const STD_WEIGHT_POSITION = 1 / 20;
const STD_WEIGHT_VELOCITY = 1 / 160;

export class KalmanFilterXYAH {
  private readonly motion: Matrix; // 8×8
  private readonly observation: Matrix; // 4×8

  constructor() {
    const f = Matrix.identity(8);
    for (let i = 0; i < 4; i++) f.set(i, 4 + i, 1); // dt = 1 кадр
    this.motion = f;
    const h = new Matrix(4, 8);
    for (let i = 0; i < 4; i++) h.set(i, i, 1);
    this.observation = h;
  }

  /** Новый трек из измерения (x, y, a, h). */
  initiate(m: number[]): { mean: number[]; cov: Matrix } {
    const mean = [...m, 0, 0, 0, 0];
    const wp = STD_WEIGHT_POSITION, wv = STD_WEIGHT_VELOCITY;
    const std = [2 * wp * m[3], 2 * wp * m[3], 1e-2, 2 * wp * m[3], 10 * wv * m[3], 10 * wv * m[3], 1e-5, 10 * wv * m[3]];
    return { mean, cov: Matrix.diag(std.map((s) => s * s)) };
  }

  predict(mean: number[], cov: Matrix): { mean: number[]; cov: Matrix } {
    const wp = STD_WEIGHT_POSITION, wv = STD_WEIGHT_VELOCITY;
    const std = [wp * mean[3], wp * mean[3], 1e-2, wp * mean[3], wv * mean[3], wv * mean[3], 1e-5, wv * mean[3]];
    const q = Matrix.diag(std.map((s) => s * s));
    const newMean = new Array<number>(8).fill(0);
    for (let i = 0; i < 8; i++) {
      let s = 0;
      for (let j = 0; j < 8; j++) s += this.motion.get(i, j) * mean[j];
      newMean[i] = s;
    }
    const newCov = this.motion.mul(cov).mul(this.motion.t()).add(q);
    return { mean: newMean, cov: newCov };
  }

  private project(mean: number[], cov: Matrix): { mean: number[]; cov: Matrix } {
    const wp = STD_WEIGHT_POSITION;
    const std = [wp * mean[3], wp * mean[3], 1e-1, wp * mean[3]];
    const r = Matrix.diag(std.map((s) => s * s));
    return { mean: mean.slice(0, 4), cov: this.observation.mul(cov).mul(this.observation.t()).add(r) };
  }

  update(mean: number[], cov: Matrix, measurement: number[]): { mean: number[]; cov: Matrix } {
    const p = this.project(mean, cov);
    // K = P Hᵀ S⁻¹
    const gain = cov.mul(this.observation.t()).mul(p.cov.inverse()); // 8×4
    const newMean = [...mean];
    for (let i = 0; i < 8; i++) {
      let s = 0;
      for (let j = 0; j < 4; j++) s += gain.get(i, j) * (measurement[j] - p.mean[j]);
      newMean[i] += s;
    }
    const newCov = cov.sub(gain.mul(p.cov).mul(gain.t()));
    return { mean: newMean, cov: newCov };
  }
}
