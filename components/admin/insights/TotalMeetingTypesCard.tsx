"use client";

import { VideoIcon } from "lucide-react";
import React from "react";
import DocumentCountCard from "./DocumentCountCard";

const TotalMeetingTypesCard = () => {
  return (
    <DocumentCountCard
      documentType="meetingType"
      title="Meeting Types"
      icon={VideoIcon}
    />
  );
};

export default TotalMeetingTypesCard;
