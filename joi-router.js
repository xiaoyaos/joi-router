'use strict';

const assert = require('assert');
const debug = require('debug')('logoran-joi-router');
const isGenFn = require('is-gen-fn');
const flatten = require('flatten');
const methods = require('methods');
const LogoranRouter = require('logoran-router');
const busboy = require('await-busboy');
const parse = require('@logoran/co-body');
const Joi = require('@logoran/joi');
const i18n = require('joi-x-i18n');
const slice = require('sliced');
const delegate = require('delegates');
const clone = require('clone');
const hoek = require('hoek');
const OutputValidator = require('./output-validator');

const validateType = {
  json: 'json',
  form: 'urlencoded',
  xml: 'xml',
  multipart: 'multipart/*',
  stream: 'multipart/*'
}

module.exports = Router;

// expose Joi for use in applications
Router.Joi = Joi;

function Router(extensions, directory, defaultLocale, suffix, cookie, queryParameter, ignoreOutValid) {
  if (!(this instanceof Router)) {
    return new Router(extensions, directory, defaultLocale, suffix, cookie, queryParameter, ignoreOutValid);
  }

  if (extensions && !extensions instanceof Array) {
    const options = extensions;
    this.joiOptions = {
      cookie: extensions.cookie,
      queryParameter: extensions.queryParameter,
      ignoreOutValid: extensions.ignoreOutValid
    }
    directory =  options.directory;
    defaultLocale = options.defaultLocale;
    suffix = options.suffix;
    extensions = options.extensions;
  } else {
    this.joiOptions = {
      cookie: cookie,
      queryParameter: queryParameter,
      ignoreOutValid: ignoreOutValid
    }
  }

  extensions = extensions || [];
  extensions = hoek.unique(extensions.concat('joi-date-extensions', 'joi-enum-extensions'));
  const modules = [];
  extensions.forEach( name => {
    try {
      modules.push(require(name));
    } catch (e) {
      console.warn('Load joi extensions ', name, ' error');
    }
  });

  const joi = Joi.extend(modules);
  this.Joi = this.joiOptions.joi = i18n(joi, directory, defaultLocale, suffix);

  this.routes = [];
  this.router = new LogoranRouter();
}

/**
 * Array of routes
 *
 * Router.prototype.routes;
 * @api public
 */

/**
 * Delegate methods to internal router object
 */

delegate(Router.prototype, 'router')
  .method('prefix')
  .method('use')
  .method('param');

/**
 * Return logoran middleware
 * @return {Function}
 * @api public
 */

Router.prototype.middleware = function middleware() {
  return this.router.routes();
};

/**
 * Adds a route or array of routes to this router, storing the route
 * in `this.routes`.
 *
 * Example:
 *
 *   var admin = router();
 *
 *   admin.route({
 *     method: 'get',
 *     path: '/do/stuff/:id',
 *     handler: function *(next){},
 *     validate: {
 *       header: Joi object
 *       params: Joi object (:id)
 *       query: Joi object (validate key/val pairs in the querystring)
 *       body: Joi object (the request payload body) (json or form or xml)
 *       maxBody: '64kb' // (json, x-www-form-urlencoded only - not stream size)
 *                       // optional
 *       type: 'json|form|multipart|xml' (required when body is specified)
 *       failure: 400 // http error code to use
 *     },
 *     meta: { // this is ignored but useful for doc generators etc
 *       desc: 'We can use this for docs generation.'
 *       produces: ['application/json']
 *       model: {} // response object definition
 *     }
 *   })
 *
 * @param {Object} spec
 * @return {Router} self
 * @api public
 */

Router.prototype.route = function route(spec) {
  if (Array.isArray(spec)) {
    for (let i = 0; i < spec.length; i++) {
      this._addRoute(spec[i]);
    }
  } else {
    this._addRoute(spec);
  }

  return this;
};

/**
 * Adds a route to this router, storing the route
 * in `this.routes`.
 *
 * @param {Object} spec
 * @api private
 */

Router.prototype._addRoute = function addRoute(spec) {
  this._validateRouteSpec(spec);
  this.routes.push(spec);

  debug('add %s "%s"', spec.method, spec.path);

  const bodyParser = makeBodyParser(spec);
  const specExposer = makeSpecExposer(spec);
  const validator = makeValidator(spec, this.joiOptions);
  const handlers = flatten(spec.handler);

  const args = [
    spec.path,
    prepareRequest,
    specExposer,
    bodyParser,
    validator
  ].concat(handlers);

  const router = this.router;

  spec.method.forEach((method) => {
    router[method].apply(router, args);
  });
};

/**
 * Validate the spec passed to route()
 *
 * @param {Object} spec
 * @api private
 */

Router.prototype._validateRouteSpec = function validateRouteSpec(spec) {
  assert(spec, 'missing spec');

  const ok = typeof spec.path === 'string' || spec.path instanceof RegExp;
  assert(ok, 'invalid route path');

  checkHandler(spec);
  checkMethods(spec);
  checkValidators(this.joiOptions.joi, spec, this.joiOptions.ignoreOutValid);
};

/**
 * @api private
 */

function checkHandler(spec) {
  if (!Array.isArray(spec.handler)) {
    spec.handler = [spec.handler];
  }

  return flatten(spec.handler).forEach(isSupportedFunction);
}

/**
 * @api private
 */

function isSupportedFunction(handler) {
  assert.equal('function', typeof handler, 'route handler must be a function');

  if (isGenFn(handler)) {
    throw new Error(`route handlers must not be GeneratorFunctions
       Please use "async function" or "function".`);
  }
}

/**
 * Validate the spec.method
 *
 * @param {Object} spec
 * @api private
 */

function checkMethods(spec) {
  assert(spec.method, 'missing route methods');

  if (typeof spec.method === 'string') {
    spec.method = spec.method.split(' ');
  }

  if (!Array.isArray(spec.method)) {
    throw new TypeError('route methods must be an array or string');
  }

  if (spec.method.length === 0) {
    throw new Error('missing route method');
  }

  spec.method.forEach((method, i) => {
    assert(typeof method === 'string', 'route method must be a string');
    spec.method[i] = method.toLowerCase();
  });
}

/**
 * Validate the spec.validators
 *
 * @param {Object} spec
 * @api private
 */

function checkValidators(joi, spec, ignoreOutValid) {
  if (!spec.validate) return;

  let text;
  if (spec.validate.body) {
    text = 'validate.type must be declared when using validate.body';
    assert(/json|form|xml/.test(spec.validate.type), text);
    if (spec.validate.type === 'xml') {
      spec.validate.xmlArray = spec.validate.xmlArray || false;
      spec.validate.xmlRoot = spec.validate.xmlRoot || false;
    }
  }

  let type = spec.validate.type;
  if (type) {
    if (!Array.isArray(spec.validate.type)) {
      spec.validate.type = type = [spec.validate.type];
    }

    text = 'validate.type must be either json, form, xml, multipart, stream or array of them';
    type.forEach((t, i) => {
      assert(typeof t === 'string', text);
      assert(/json|form|xml|multipart|stream/i.test(t), text);
      type[i] = validateType[t];
    });
  }

  if (spec.validate.output && !ignoreOutValid && !spec.validate.output.ignore) {
    delete spec.validate.output.ignore;
    spec.validate._outputValidator = new OutputValidator(joi, spec.validate.output);
  }

  // default HTTP status code for failures
  if (!spec.validate.failure) {
    spec.validate.failure = 400;
  }
}

/**
 * Creates body parser middleware.
 *
 * @param {Object} spec
 * @return {async function}
 * @api private
 */

function makeBodyParser(spec) {
  return async function parsePayload(ctx, next) {
    if (!(spec.validate && spec.validate.type && undefined === ctx.request.body)) return await next();

    let opts;

    try {
      switch (ctx.request.is(spec.validate.type)) {
        case 'json':
          opts = {
            limit: spec.validate.maxBody
          };

          ctx.request.body = await parse.json(ctx, opts);
          break;

        case 'urlencoded':
          opts = {
            limit: spec.validate.maxBody
          };

          ctx.request.body = await parse.form(ctx, opts);
          break;

        case 'xml':
          opts = {
            limit: spec.validate.maxBody,
            explicitArray: spec.validate.xmlArray,
            explicitRoot: spec.validate.xmlRoot
          };

          ctx.request.body = await parse.xml(ctx, opts);
          break;

        case 'multipart/form-data':
          opts = spec.validate.multipartOptions || {}; // TODO document this
          opts.autoFields = true;

          ctx.request.parts = busboy(ctx, opts);
          break;

        default:
          return ctx.throw(400, 'expected ' + spec.validate.type.join() + ' but no match');
      }
    } catch (err) {
      if (!spec.validate.continueOnError) return ctx.throw(err);
      captureError(ctx, 'type', err);
    }

    await next();
  };
}

/**
 * @api private
 */

function captureError(ctx, type, err) {
  // expose Error message to JSON.stringify()
  err.msg = err.message;
  if (!ctx.invalid) ctx.invalid = {};
  ctx.invalid[type] = err;
}

/**
 * @api private
 */

function getUserLocale(ctx, cookie, queryParameter) {
  return (cookie && ctx.cookies.get(cookie)) || (queryParameter && ctx.query[queryParameter]);
}

/**
 * Creates validator middleware.
 *
 * @param {Object} spec
 * @return {async function}
 * @api private
 */

function makeValidator(spec, options) {
  const props = 'header query params body'.split(' ');

  return async function validator(ctx, next) {
    if (!spec.validate) return await next();

    let err;

    const locale = getUserLocale(ctx, options.cookie, options.queryParameter);

    for (let i = 0; i < props.length; ++i) {
      const prop = props[i];

      if (spec.validate[prop]) {
        err = validateInput(prop, ctx, spec.validate, options.joi, locale);

        if (err) {
          if (!spec.validate.continueOnError) return ctx.throw(err);
          captureError(ctx, prop, err);
        }
      }
    }

    await next();

    if (spec.validate._outputValidator) {
      debug('validating output');

      err = spec.validate._outputValidator.validate(ctx, locale);
      if (err) {
        err.status = 500;
        return ctx.throw(err);
      }
    }
  };
}

/**
 * Exposes route spec.
 *
 * @param {Object} spec
 * @return {async function}
 * @api private
 */
function makeSpecExposer(spec) {
  const defn = clone(spec);
  return async function specExposer(ctx, next) {
    ctx.state.route = defn;
    await next();
  };
}

/**
 * Middleware which creates `request.params`.
 *
 * @api private
 */

async function prepareRequest(ctx, next) {
  ctx.request.params = ctx.params;
  await next();
}

/**
 * Validates request[prop] data with the defined validation schema.
 *
 * @param {String} prop
 * @param {logoran.Request} request
 * @param {Object} validate
 * @returns {Error|undefined}
 * @api private
 */

function validateInput(prop, ctx, validate, joi, locale) {
  debug('validating %s', prop);

  const request = ctx.request;
  const res = joi.validate(request[prop], validate[prop], {i18n: locale});

  if (res.error) {
    res.error.status = validate.failure;
    return res.error;
  }

  // update our request w/ the casted values
  switch (prop) {
    case 'header': // request.header is getter only, cannot set it
    case 'query': // setting request.query directly causes casting back to strings
      Object.keys(res.value).forEach((key) => {
        request[prop][key] = res.value[key];
      });
      break;
    case 'params':
      request.params = ctx.params = res.value;
      break;
    default:
      request[prop] = res.value;
  }
}

/**
 * Routing shortcuts for all HTTP methods
 *
 * Example:
 *
 *    var admin = router();
 *
 *    admin.get('/user', async function(ctx) {
 *      ctx.body = ctx.session.user;
 *    })
 *
 *    var validator = Joi().object().keys({ name: Joi.string() });
 *    var config = { validate: { body: validator }};
 *
 *    admin.post('/user', config, async function(ctx){
 *      console.log(ctx.body);
 *    })
 *
 *    async function commonHandler(ctx){
 *      // ...
 *    }
 *    admin.post('/account', [commonHandler, async function(ctx){
 *      // ...
 *    }]);
 *
 * @param {String} path
 * @param {Object} [config] optional
 * @param {async function|async function[]} handler(s)
 * @return {App} self
 */

methods.forEach((method) => {
  method = method.toLowerCase();

  Router.prototype[method] = function(path) {
    // path, handler1, handler2, ...
    // path, config, handler1
    // path, config, handler1, handler2, ...
    // path, config, [handler1, handler2], handler3, ...

    let fns;
    let config;

    if (typeof arguments[1] === 'function' || Array.isArray(arguments[1])) {
      config = {};
      fns = slice(arguments, 1);
    } else if (typeof arguments[1] === 'object') {
      config = arguments[1];
      fns = slice(arguments, 2);
    }

    const spec = {
      path: path,
      method: method,
      handler: fns
    };

    Object.assign(spec, config);

    this.route(spec);
    return this;
  };
});
