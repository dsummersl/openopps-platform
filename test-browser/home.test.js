var chai = require('chai');
var expect = chai.expect;
var assert = chai.assert;
var casper_chai = require('casper-chai');
chai.use(casper_chai);

// access environment vars
var system = require('system');

describe('Home page', function() {
  before(function() {
    casper.start('http://'+system.env.TEST_SERVER, function afterStart() {
      this.options = {
        verbose: true,
        logLevel: "debug",
        waitTimeout: 5000
      }
      this.on('remote.message', function(message) {
        this.log('browser console.log ==> ' + message);
      });
    }).viewport(1000,1000).userAgent('Mozilla/5.0')

  })

  it('should have success status', function() {
    casper.then(function() {
      assert.equal(casper.currentHTTPStatus,200);
    })
  })

  it('should have correct title', function() {
    casper.then(function() {
      assert.equal(casper.getTitle(), "midas");
    })
  })

  it('should link to /tasks', function() {
    casper.then(function() {
      casper.waitForText('Opportunities', function waitForTextOpportunities() {
        casper.click('.tasks .nav-link[href]')
        assert.equal(casper.getCurrentUrl(), 'http://localhost:1337/tasks');
      })
    });
  });


});
