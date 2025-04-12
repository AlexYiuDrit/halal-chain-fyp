const HalalCertificate = artifacts.require("HalalCertificate");

module.exports = function (deployer) {
    deployer.deploy(HalalCertificate);
};