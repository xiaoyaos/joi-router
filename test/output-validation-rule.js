'use strict';

const Rule = require('../output-validation-rule');
const Joi = require('@logoran/joi');
const assert = require('assert');

describe('OutputValidationRule', () => {
  describe('.overlaps()', () => {
    it('properly detects when rules do not overlap', () => {
      const spec = { body: { a: Joi.any().required() } };
      const a = new Rule(Joi, '200', spec);
      const b = new Rule(Joi, '201', spec);
      assert.strictEqual(false, a.overlaps(b));
    });
  });
});
