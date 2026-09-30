// Tags a GWN70x2 with the capabilities its data model lacks, so the
// baseline action profiles that exclude the tag stop offering them.
// See capabilities.yaml for why this is a tag and not a selector.
(function () {
  const unsupported = ["wifi-scan:unsupported"];
  for (let i = 0; i < unsupported.length; i++) {
    if (!device.hasTag(unsupported[i])) device.addTag(unsupported[i]);
  }
})();
