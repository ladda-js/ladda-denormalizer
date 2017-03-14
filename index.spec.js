import { build } from '../../builder';
import { uniq, compose, map, flatten, curry, prop, head, last, toObject, values } from '../../fp';
import { denormalizer, extractAccessors } from '.';

const toIdMap = toObject(prop('id'));

const peter = { id: 'peter' };
const gernot = { id: 'gernot' };
const robin = { id: 'robin' };

const users = toIdMap([peter, gernot, robin]);

const c1 = { id: 'a' };
const c2 = { id: 'b' };

const comments = toIdMap([c1, c2]);

const m1 = {
  id: 'x',
  author: peter.id,
  recipient: gernot.id,
  visibleTo: [robin.id],
  nestedData: {
    comments: [c1.id, c2.id]
  }
};
const m2 = {
  id: 'y',
  author: gernot.id,
  recipient: peter.id,
  visibleTo: [],
  nestedData: {
    comments: []
  }
};

const messages = toIdMap([m1, m2]);

const getById = curry((m, id) => Promise.resolve(m[id]));
const getAll = (m) => () => Promise.resolve(values(m));

const getUser = getById(users);
getUser.operation = 'READ';
getUser.byId = true;
const getUsers = getAll(users);
getUser.operation = 'READ';

const getMessage = getById(messages);
getMessage.operation = 'READ';
getMessage.byId = true;
const getMessages = getAll(messages);
getMessages.operation = 'READ';

const getComment = getById(comments);
getComment.operation = 'READ';
getComment.byId = true;
const getComments = getAll(comments);
getComments.operation = 'READ';


const config = () => ({
  user: {
    api: { getUser, getUsers },
    plugins: {
      denormalizer: {
        getOne: 'getUser',
        getAll: 'getUsers',
        threshold: 5
      }
    }
  },
  message: {
    api: { getMessage, getMessages },
    plugins: {
      denormalizer: {
        schema: {
          author: 'user',
          recipient: 'user',
          visibleTo: ['user'],
          nestedData: {
            comments: ['comment']
          }
        }
      }
    }
  },
  comment: {
    api: { getComment, getComments },
    plugins: {
      denormalizer: {
        getOne: 'getComment',
        getAll: 'getComments'
      }
    }
  }
});

const expectResolved = curry((k, val, obj) => {
  expect(obj[k]).to.deep.equal(val);
  return obj;
});

describe('denormalizer', () => {
  describe('with a fn, that returns one object', () => {
    it('resolves references to simple id fields', (done) => {
      const api = build(config(), [denormalizer()]);
      api.message.getMessage(m1.id)
        .then(expectResolved('author', users[m1.author]))
        .then(expectResolved('recipient', users[m1.recipient]))
        .then(() => done());
    });

    it('resolves references to lists of ids', (done) => {
      const api = build(config(), [denormalizer()]);
      api.message.getMessage(m1.id)
        .then(expectResolved('visibleTo', [users[m1.visibleTo[0]]]))
        .then(() => done());
    });

    it('resolves references for nested data', (done) => {
      const api = build(config(), [denormalizer()]);
      api.message.getMessage(m1.id)
        .then((m) => expectResolved('comments', [c1, c2], m.nestedData))
        .then(() => done());
    })
  });

  describe('with a fn, that returns a list of objects', () => {
    it('resolves references to simple id fields', (done) => {
      const api = build(config(), [denormalizer()]);
      api.message.getMessages()
        .then((msgs) => {
          const fst = head(msgs);
          const snd = last(msgs);
          expectResolved('author', users[m1.author])(fst);
          expectResolved('recipient', users[m1.recipient])(fst);

          expectResolved('author', users[m2.author])(snd);
          expectResolved('recipient', users[m2.recipient])(snd);
        })
        .then(() => done());
    });
  });
});

describe('denormalization-helpers', () => {
  const createConfig = () => [
    {
      name: 'message',
      plugins: {
        denormalizer: {
          schema: {
            author: 'user',
            recipient: 'user',
            visibleTo: ['user'],
            nestedData: {
              comments: ['comment']
            }
          }
        }
      }
    },
    {
      name: 'review',
      plugins: {
        denormalizer: {
          schema: {
            author: 'user',
            meta: {
              data: {
                comments: ['comment']
              }
            }
          }
        }
      }
    }
  ];

  describe('extractAccessors', () => {
    it('parses config and returns all paths to entities defined in schemas', () => {
      const expected = {
        message: {
          author: 'user',
          recipient: 'user',
          visibleTo: ['user'],
          'nestedData.comments': ['comment']
        },
        review: {
          author: 'user',
          'meta.data.comments': ['comment']
        }
      };

      const actual = extractAccessors(createConfig());
      expect(actual).to.deep.equal(expected);
    });
  });
});

