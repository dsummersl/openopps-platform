/* jshint laxcomma:true */

var path     = require('path')
  , url      = require('url')
  , passport = require('passport')
  , request  = require('request');

/**
 * Passport Service
 *
 * A painless Passport.js service for your Sails app that is guaranteed to
 * Rock Your Socks™. It takes all the hassle out of setting up Passport.js by
 * encapsulating all the boring stuff in two functions:
 *
 *   passport.endpoint()
 *   passport.callback()
 *
 * The former sets up an endpoint (/auth/:provider) for redirecting a user to a
 * third-party provider for authentication, while the latter sets up a callback
 * endpoint (/auth/:provider/callback) for receiving the response from the
 * third-party provider. All you have to do is define in the configuration which
 * third-party providers you'd like to support. It's that easy!
 *
 * Behind the scenes, the service stores all the data it needs within "Pass-
 * ports". These contain all the information required to associate a local user
 * with a profile from a third-party provider. This even holds true for the good
 * ol' password authentication scheme – the Authentication Service takes care of
 * encrypting passwords and storing them in Passports, allowing you to keep your
 * User model free of bloat.
 */

// Load authentication protocols
passport.protocols = require('./protocols');

/**
 * Connect a third-party profile to a local user
 *
 * This is where most of the magic happens when a user is authenticating with a
 * third-party provider. What it does, is the following:
 *
 *   1. Given a provider and an identifier, find a matching Passport.
 *   2. From here, the logic branches into two paths.
 *
 *     - A user is not currently logged in:
 *       1. If a Passport wasn't found, create a new user as well as a new
 *          Passport that will be assigned to the user.
 *       2. If a Passport was found, get the user associated with the passport.
 *
 *     - A user is currently logged in:
 *       1. If a Passport wasn't found, create a new Passport and associate it
 *          with the already logged in user (ie. "Connect")
 *       2. If a Passport was found, nothing needs to happen.
 *
 * As you can see, this function handles both "authentication" and "authori-
 * zation" at the same time. This is due to the fact that we pass in
 * `passReqToCallback: true` when loading the strategies, allowing us to look
 * for an existing session in the request and taking action based on that.
 *
 * For more information on auth(entication|rization) in Passport.js, check out:
 * http://passportjs.org/guide/authenticate/
 * http://passportjs.org/guide/authorize/
 *
 * @param {Object}   req
 * @param {Object}   query
 * @param {Object}   profile
 * @param {Function} next
 */
passport.connect = function (req, query, profile, next) {
  sails.log.verbose('passport.connect')
  var user = {}
    , provider;

  // Get the authentication provider from the query.
  query.provider = req.param('provider');

  // Use profile.provider or fallback to the query.provider if it is undefined
  // as is the case for OpenID, for example
  provider = profile.provider || query.provider;

  if (provider === 'linkedin') profile = linkedinProfile(profile);

  // If the provider cannot be identified we cannot match it to a passport so
  // throw an error and let whoever's next in line take care of it.
  if (!provider){
    return next(new Error('No authentication provider was identified.'));
  }

  // If the profile object contains a list of emails, grab the first one and
  // add it to the user.
  if (profile.hasOwnProperty('emails')) {
    user.username = profile.emails[0].value;
  }

  // If neither an email or a username was available in the profile, we don't
  // have a way of identifying the user in the future. Throw an error and let
  // whoever's next in the line take care of it.
  if (!user.username && !user.email) {
    return next(new Error('Neither a username nor email was available'));
  }

  // Get profile values for new users
  user = _.defaults(user, {
    name: profile.displayName,
    photoUrl: profile.photoUrl,
    title: profile.title,
    bio: profile.bio
  });

  Passport.findOne({
    provider   : provider
  , identifier : query.identifier.toString()
  }, function (err, passport) {
    if (err) {
      return next(err);
    }

    if (!req.user) {
      // Scenario: A new user is attempting to sign up using a third-party
      //           authentication provider.
      // Action:   Create a new user and assign them a passport.
      if (!passport) {
        sails.log.verbose('new user with 3rd party auth');
        User.findOrCreate({ username: user.username }, user, function(err, user) {
          if (err) return next(err);

          query.user = user.id;

          Passport.create(query, function (err, passport) {
            // If a passport wasn't created, bail out
            if (err) {
              return next(err);
            }

            next(err, user);
          });
        });
      }
      // Scenario: An existing user is trying to log in using an already
      //           connected passport.
      // Action:   Get the user associated with the passport.
      else {
        sails.log.verbose('existing user with already connected passport:', passport.user);
        // If the tokens have changed since the last session, update them
        if (query.hasOwnProperty('tokens') && query.tokens !== passport.tokens) {
          passport.tokens = query.tokens;
        }

        // Save any updates to the Passport before moving on
        passport.save(function (err, obj) {
          if (err) {
            return next(err);
          }

          // Fetch the user associated with the Passport
          User.findOne(passport.user).populate('tags')
          .exec(function(err, user) {
            if (err) sails.log.verbose('error finding user:', err);
            next(err, user);
          });
        });
      }
    } else {
      // Scenario: A user is currently logged in and trying to connect a new
      //           passport.
      // Action:   Create and assign a new passport to the user.
      if (!passport) {
        sails.log.verbose('connecting new passport');
        query.user = req.user.id;

        Passport.create(query, function (err, passport) {
          // If a passport wasn't created, bail out
          if (err) {
            return next(err);
          }

          next(err, req.user);
        });
      }
      // Scenario: Connection already exists.
      // Action:   Simply pass along the already established session.
      else {
        sails.log.verbose('re-connecting passport to existing session');
        next(null, req.user);
      }
    }
  });
};

/**
 * Create an authentication endpoint
 *
 * For more information on authentication in Passport.js, check out:
 * http://passportjs.org/guide/authenticate/
 *
 * @param  {Object} req
 * @param  {Object} res
 */
passport.endpoint = function (req, res) {
  sails.log.verbose('passport.endpoint')

  var strategies = sails.config.passport
    , provider   = req.param('provider')
    , options    = {};

  // If a provider doesn't exist for this endpoint, send the user back to the
  // login page
  if (!strategies.hasOwnProperty(provider)) {
    return res.redirect('/');
  }

  // Attach scope if it has been set in the config
  if (strategies[provider].hasOwnProperty('scope')) {
    options.scope = strategies[provider].scope;
  }

  // Redirect the user to the provider for authentication. When complete,
  // the provider will redirect the user back to the application at
  //     /auth/:provider/callback
  this.authenticate(provider, options)(req, res, req.next);
};

/**
 * Create an authentication callback endpoint
 *
 * For more information on authentication in Passport.js, check out:
 * http://passportjs.org/guide/authenticate/
 *
 * @param {Object}   req
 * @param {Object}   res
 * @param {Function} next
 */
passport.callback = function (req, res, next) {
  sails.log.verbose('passport.callback')

  var provider = req.param('provider', 'local')
    , action   = req.param('action');

  // Passport.js wasn't really built for local user registration, but it's nice
  // having it tied into everything else.
  if (provider === 'local' && action !== undefined) {
    if (action === 'register' && !req.user) {
      this.protocols.local.register(req, res, next);
    }
    else if (action === 'connect' && req.user) {
      this.protocols.local.connect(req, res, next);
    }
    else if (action === 'disconnect' && req.user) {
      this.disconnect(req, res, next);
    }
    else {
      next(new Error('Invalid action'));
    }
  } else {
    if (action === 'disconnect' && req.user) {
      this.disconnect(req, res, next) ;
    } else {
      // The provider will redirect the user to this URL after approval. Finish
      // the authentication process by attempting to obtain an access token. If
      // access was granted, the user will be logged in. Otherwise, authentication
      // has failed.
      this.authenticate(provider, next)(req, res, req.next);
    }
  }
};

/**
 * Load all strategies defined in the Passport configuration
 *
 * For example, we could add this to our config to use the GitHub strategy
 * with permission to access a users email address (even if it's marked as
 * private) as well as permission to add and update a user's Gists:
 *
    github: {
      name: 'GitHub',
      protocol: 'oauth2',
      strategy: require('passport-github').Strategy
      scope: [ 'user', 'gist' ]
      options: {
        clientID: 'CLIENT_ID',
        clientSecret: 'CLIENT_SECRET'
      }
    }
 *
 * For more information on the providers supported by Passport.js, check out:
 * http://passportjs.org/guide/providers/
 *
 */
passport.loadStrategies = function () {
  var self       = this
    , strategies = sails.config.passport;
  sails.log.verbose('passport.loadStrategies', strategies)

  Object.keys(strategies).forEach(function (key) {
    var options = { passReqToCallback: true }, Strategy;

    if (key === 'local') {
      // Since we need to allow users to login using both usernames as well as
      // emails, we'll set the username field to something more generic.
      _.extend(options, { usernameField: 'identifier' });

      //Let users override the username and passwordField from the options
      _.extend(options, strategies[key].options || {});

      // Only load the local strategy if it's enabled in the config
      if (strategies.local) {
        Strategy = strategies[key].strategy;

        self.use(new Strategy(options, self.protocols.local.login));
      }
    } else if (key === 'bearer') {

      if (strategies.bearer) {
        Strategy = strategies[key].strategy;
        self.use(new Strategy(self.protocols.bearer.authorize));
      }

    } else {
      var protocol = strategies[key].protocol
        , callback = strategies[key].callback;

      if (!callback) {
        callback = 'auth/' + key + '/callback';
      }

      Strategy = strategies[key].strategy;

      var baseUrl = sails.config.appUrl;

      switch (protocol) {
        case 'oauth':
        case 'oauth2':
          options.callbackURL = url.resolve(baseUrl, callback);
          break;

        case 'openid':
          options.returnURL = url.resolve(baseUrl, callback);
          options.realm     = baseUrl;
          options.profile   = true;
          break;
      }

      // Merge the default options with any options defined in the config. All
      // defaults can be overriden, but I don't see a reason why you'd want to
      // do that.
      _.extend(options, strategies[key].options);

      self.use(new Strategy(options, self.protocols[protocol]));
    }
  });
};

/**
 * Disconnect a passport from a user
 *
 * @param  {Object} req
 * @param  {Object} res
 */
passport.disconnect = function (req, res, next) {
  sails.log.verbose('passport.disconnect')
  var user     = req.user
    , provider = req.param('provider', 'local')
    , query    = {};

  query.user = user.id;
  query[provider === 'local' ? 'protocol' : 'provider'] = provider;

  Passport.findOne(query, function (err, passport) {
    if (err) {
      return next(err);
    } else if (!passport) {
      return next({ message: 'No passport found.'} );
    }

    Passport.destroy(passport.id, function (error) {
      if (err) {
          return next(err);
      }

      next(null, user);
    });
  });
};

passport.serializeUser(function (user, next) {
  next(null, user.id);
});

passport.deserializeUser(function (id, next) {
  // TODO: consider caching active users
  User.findOne(id).populate('tags').populate('badges').exec(function(err, user){
    if (err) next(err);
    next(null, user);
  });
});

module.exports = passport;
