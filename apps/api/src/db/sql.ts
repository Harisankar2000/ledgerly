/**
 * Builds a parameterised WHERE clause from optional filters. Values are always
 * bound as $n placeholders; only the fixed SQL fragments are concatenated.
 *
 *   const where = new WhereBuilder().add('currency = ?', 'INR').addIf(type, 'type = ?', type);
 *   db.query(`SELECT … ${where.sql} LIMIT ${where.param(20)}`, where.params)
 */
export class WhereBuilder {
  private readonly conditions: string[] = [];
  readonly params: unknown[] = [];

  /** Binds a value and returns its placeholder, e.g. for LIMIT/OFFSET. */
  param(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  /** `fragment` uses `?` for each value, e.g. `'amount BETWEEN ? AND ?'`. */
  add(fragment: string, ...values: unknown[]): this {
    let index = 0;
    this.conditions.push(fragment.replace(/\?/g, () => this.param(values[index++])));
    return this;
  }

  addIf(condition: unknown, fragment: string, ...values: unknown[]): this {
    return condition === undefined || condition === null || condition === ''
      ? this
      : this.add(fragment, ...values);
  }

  get sql(): string {
    return this.conditions.length ? `WHERE ${this.conditions.join(' AND ')}` : '';
  }
}
