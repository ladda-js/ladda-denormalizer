import {
  compose, curry, head, init, last, map, map_, mapObject, mapValues,
  prop, reduce, fromPairs, toPairs, values,
  uniq, flatten, get, set, snd, toIdMap
} from 'ladda-fp';

/* TYPES
 *
 * Path = [String]
 *
 * Accessors = [ (Path, Type | [Type]) ]
 *
 * FetcherDef = {
 *  getOne: { name: String, fn: id -> Promise Entity }
 *  getSome: { name: String, fn: [id] -> Promise [Entity] }
 *  getAll: { name: string, fn: Promise [Entity] }
 *  threshold: Int
 * }
 *
 */

export const NAME = 'denormalizer';

const DEFAULTS = {
  threshold: Infinity,
  maxDepth: 12
};

const compact = (l) => reduce((m, el) => {
  if (el) {
    m.push(el);
  }
  return m;
}, [], l);

const def = curry((a, b) => b || a);

const isSecretParam = (obj) => obj && obj.__laddaDenormalizerParams;
const getSecretParamPayload = (obj) => obj.__laddaDenormalizerParams;
const createSecretParam = (payload = {}) => ({ __laddaDenormalizerParams: payload });

const getApi = curry((configs, entityName) => compose(prop('api'), prop(entityName))(configs));

const getPluginConf_ = curry((config) => compose(prop(NAME), def({}), prop('plugins'))(config));

const getSchema_ = (config) => compose(prop('schema'), def({}), getPluginConf_)(config);

const getPluginConf = curry((cs, entityName) => getPluginConf_(cs[entityName]));

const collectTargets = curry((accessors, res, item) => {
  return reduce((m, [path, type]) => {
    let list = m[type];
    if (!list) { list = []; }
    const val = get(path, item);
    if (Array.isArray(val)) {
      list = list.concat(val);
    } else {
      list.push(val);
    }
    m[type] = list;
    return m;
  }, res, accessors);
});

const resolveItem = curry((accessors, entities, item) => {
  return reduce((m, [path, type]) => {
    const val = get(path, item);
    const getById = (id) => {
      return id === null || id === undefined ? id : entities[type][id];
    };
    const resolvedVal = Array.isArray(val) ? map(getById, val) : getById(val);
    return set(path, resolvedVal, m);
  }, item, accessors);
});

const resolveItems = curry((accessors, items, entities) => {
  return map(resolveItem(accessors, entities), items);
});

const requestEntities = curry(({ getOne, getSome, getAll, threshold }, params, ids) => {
  const validIds = compact(ids);
  const noOfItems = validIds.length;

  const nextParams = createSecretParam({ ...params, level: params.level + 1 });

  if (noOfItems === 1) {
    return getOne.fn(validIds[0], nextParams).then((e) => [e]);
  }
  if (noOfItems > threshold && getAll.fn) {
    return getAll.fn(nextParams);
  }
  return getSome.fn(validIds, nextParams);
});

const resolve = curry((fetchers, accessors, params, items) => {
  const requestsToMake = compose(reduce(collectTargets(accessors), {}))(items);
  return Promise.all(mapObject(([t, ids]) => {
    return requestEntities(fetchers[t], params, ids).then((es) => [t, es]);
  }, requestsToMake)).then(
    compose(resolveItems(accessors, items), mapValues(toIdMap), fromPairs)
  );
});

const parseSchema = (schema) => {
  return reduce((m, [field, val]) => {
    if (Array.isArray(val) || typeof val === 'string') {
      m[field] = val;
    } else {
      const nextSchema = parseSchema(val);
      Object.keys(nextSchema).forEach((k) => {
        m[[field, k].join('.')] = nextSchema[k];
      });
    }
    return m;
  }, {}, toPairs(schema));
};


// EntityConfigs -> Map String Accessors
export const extractAccessors = (configs) => {
  const asMap = reduce((m, c) => {
    const schema = getSchema_(c);
    if (schema) { m[c.name] = parseSchema(schema); }
    return m;
  }, {}, configs);
  return mapValues(compose(map(([ps, v]) => [ps.split('.'), v]), toPairs))(asMap);
};

const getConfField = curry((field, objs) => {
  const finalVal = reduce((val, obj) => (val !== undefined ? val : obj[field]), undefined, objs);
  return finalVal === undefined ? DEFAULTS[field] : finalVal;
});

// PluginConfig -> EntityConfigs -> [Type] -> Map Type FetcherDef
const extractFetchers = (pluginConfig, configs, types) => {
  return compose(fromPairs, map((t) => {
    const conf = getPluginConf(configs, t);
    const api = getApi(configs, t);
    if (!conf) {
      throw new Error(`No denormalizer config found for type ${t}`);
    }

    const nameFromApi = (p) => ({ name: (api[conf[p]] || {}).name });
    const getOne = nameFromApi('getOne');
    const getSome = nameFromApi('getSome');
    const getAll = nameFromApi('getAll');
    const threshold = getConfField('threshold', [conf, pluginConfig]);

    if (!getOne.name) {
      throw new Error(`No 'getOne' accessor defined on type ${t}`);
    }
    return [t, { getOne, getSome, getAll, threshold }];
  }))(types);
};

// Map Type Accessors -> [Type]
const extractTypes = compose(uniq, flatten, map(snd), flatten, values);

const registerDecoratedFn = curry((fns, entityName, fnName, fn) => {
  const eContainer = fns[entityName] || {};
  eContainer[fnName] = fn;
  fns[entityName] = eContainer;
});

const mergeFetchersAndDecoratedFns = curry((fetchers, decoratedFns) => {
  compose(
    map_(([entityName, fnDef]) => {
      const getFn = (n, d = null) => (n ? decoratedFns[entityName][n] : d);
      const addFn = (p, d) => { fnDef[p].fn = getFn(fnDef[p].name, d); };

      addFn('getOne');
      addFn('getSome', (ids, p) => Promise.all(map((id) => fnDef.getOne.fn(id, p), ids)));
      addFn('getAll');
    }),
    toPairs,
  )(fetchers);
});

const splitArgsAndParams = (allArgs, maxDepth) => {
  if (isSecretParam(last(allArgs))) {
    return { args: init(allArgs), params: getSecretParamPayload(last(allArgs)) };
  }
  return { args: allArgs, params: { level: 0, maxDepth } };
};

export const denormalizer = (pluginConfig = {}) => ({ entityConfigs }) => {
  const allAccessors = extractAccessors(values(entityConfigs));
  const allFetchers = extractFetchers(pluginConfig, entityConfigs, extractTypes(allAccessors));
  const decoratedFns = {};
  let setupCompleted = false;

  return ({ entity, fn }) => {
    const finalFn = (...allArgs) => {
      const maxDepth = getConfField('maxDepth', [pluginConfig, getPluginConf_(entity)]);
      const { args, params } = splitArgsAndParams(allArgs, maxDepth);

      return fn(...args).then((res) => {
        const accessors = allAccessors[entity.name];
        if (!accessors) {
          return res;
        }

        if (!setupCompleted) {
          mergeFetchersAndDecoratedFns(allFetchers, decoratedFns);
          setupCompleted = true;
        }

        if (params.level >= params.maxDepth) {
          return res;
        }

        const isArray = Array.isArray(res);
        const items = isArray ? res : [res];

        const resolved = resolve(allFetchers, accessors, params, items);
        return isArray ? resolved : resolved.then(head);
      });
    };

    registerDecoratedFn(decoratedFns, entity.name, fn.name, finalFn);
    return finalFn;
  };
};
